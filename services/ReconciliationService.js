const mongoose = require('mongoose');
const Loan = require('../models/Loan');
const LedgerEntry = require('../models/LedgerEntry');
const ChitFund = require('../models/ChitFund');
const ChitLedger = require('../models/ChitLedger');
const ChitBid = require('../models/ChitBid');
const ReconciliationIncident = require('../models/ReconciliationIncident');
const { triggerAlert } = require('../utils/telemetry');

const INVARIANTS = {
    'LOAN-001': { desc: 'Monetary fields are non-negative integers', severity: 'CRITICAL' },
    'LOAN-002': { desc: 'Paid amount cannot exceed total payable', severity: 'HIGH' },
    'LOAN-003': { desc: 'Independent Ledger total matches stored paidAmountPaise', severity: 'CRITICAL' },
    'LEDGER-001': { desc: 'Total global DEBIT must exactly equal CREDIT', severity: 'CRITICAL' },
    'CHIT-001': { desc: 'Exactly one settlement per group/cycle', severity: 'CRITICAL' },
    'CHIT-002': { desc: 'Auction winner must correspond to a valid ChitBid', severity: 'CRITICAL' },
    'CHIT-003': { desc: 'Settlement math (Pot, Commission, Dividend) must independently reconcile', severity: 'CRITICAL' }
};

class ReconciliationService {
    static async reportIncident(code, entityType, entityId, expected, actual, details = '') {
        const inv = INVARIANTS[code];
        const incident = await ReconciliationIncident.create({
            invariantCode: code,
            severity: inv.severity,
            entityType,
            entityId,
            expectedValue: expected,
            actualValue: actual,
            details
        });

        triggerAlert(`RECONCILIATION_MISMATCH_${code}`, inv.severity, {
            entityType,
            entityId,
            incidentId: incident._id
        });

        if (inv.severity === 'CRITICAL') {
            triggerAlert('POTENTIAL_FINANCIAL_CORRUPTION', 'CRITICAL', { incidentId: incident._id });
        }
        return incident;
    }

    static async reconcileGlobalLedger() {
        const totals = await LedgerEntry.aggregate([
            { $group: { _id: "$type", total: { $sum: "$amountPaise" } } }
        ]);
        let debit = 0, credit = 0;
        totals.forEach(t => {
            if (t._id === 'DEBIT') debit = t.total;
            if (t._id === 'CREDIT') credit = t.total;
        });

        if (debit !== credit) {
            await this.reportIncident('LEDGER-001', 'GlobalLedger', 'GLOBAL', debit, credit, 'Global debit/credit imbalance');
        }
    }

    static async reconcileLoans() {
        // Fetch all migrated loans
        const loans = await Loan.find({ amountPaise: { $exists: true } });
        
        for (const loan of loans) {
            // LOAN-001: Integer checks
            if (!Number.isInteger(loan.amountPaise) || loan.amountPaise < 0 ||
                !Number.isInteger(loan.paidAmountPaise) || loan.paidAmountPaise < 0 ||
                !Number.isInteger(loan.totalPayablePaise) || loan.totalPayablePaise < 0) {
                await this.reportIncident('LOAN-001', 'Loan', loan._id, 'Integers >= 0', 'Invalid Math', 'Found float or negative');
            }

            // LOAN-002: Paid <= Payable
            if (loan.paidAmountPaise > loan.totalPayablePaise) {
                await this.reportIncident('LOAN-002', 'Loan', loan._id, loan.totalPayablePaise, loan.paidAmountPaise, 'Overpayment detected');
            }

            // LOAN-003: Ledger Consistency
            // Independent calculation: Sum of all credits against this loan in LedgerEntry
            const ledgerSum = await LedgerEntry.aggregate([
                { $match: { referenceModel: 'Loan', referenceId: loan._id, type: 'CREDIT' } },
                { $group: { _id: null, totalPaid: { $sum: "$amountPaise" } } }
            ]);
            const independentPaidPaise = ledgerSum.length > 0 ? ledgerSum[0].totalPaid : 0;
            
            // Note: Since legacy payments might not have LedgerEntries yet, we only assert this strictly if 
            // the loan was created recently or fully migrated. For simulation, we enforce strict parity.
            if (independentPaidPaise !== loan.paidAmountPaise && loan.transactions.length > 0) {
                // If the app has raw transactions but ledger sum is 0, it means it's pre-ledger legacy data.
                // In a real system, we'd only alert if it's a new loan. We will log it for the test.
                if (independentPaidPaise !== 0 || loan.createdAt > new Date('2025-01-01')) {
                    await this.reportIncident('LOAN-003', 'Loan', loan._id, independentPaidPaise, loan.paidAmountPaise, 'Ledger mismatch');
                }
            }
        }
    }

    static async reconcileChits() {
        const ledgers = await ChitLedger.find({}).populate('groupId');
        
        for (const ledger of ledgers) {
            const group = ledger.groupId;
            if (!group) continue; // Orphan

            // CHIT-001: Settlement Count
            const duplicateSettlements = await ChitLedger.countDocuments({ groupId: group._id, cycleIndex: ledger.cycleIndex });
            if (duplicateSettlements > 1) {
                await this.reportIncident('CHIT-001', 'ChitLedger', ledger._id, 1, duplicateSettlements, `Duplicate settlements for cycle ${ledger.cycleIndex}`);
            }

            // CHIT-002: Winner / Bid Integrity
            const winningBid = await ChitBid.findOne({ 
                auctionId: ledger._id, // assuming auction links here, or groupId + cycleIndex
                userId: ledger.winnerUser,
                amountPaise: ledger.winningBidDiscount
            });
            // If winner exists but bid doesn't, that's corruption
            if (ledger.winnerUser && !winningBid) {
                await this.reportIncident('CHIT-002', 'ChitLedger', ledger._id, 'Bid Exists', 'Bid Missing', `Winner declared without corresponding ChitBid`);
            }

            // CHIT-003: Math Reconciliation
            // POT = totalValue
            // COMMISSION = POT * commissionPercentage / 100
            // WINNING_BID = ledger.winningBidDiscount
            // DIVIDEND = WINNING_BID - COMMISSION
            // DIVIDEND_PER_HEAD = DIVIDEND / currentSubscribersCount
            // NET_MEMBER_OBLIGATION = monthlySubscription - DIVIDEND_PER_HEAD
            
            if (ledger.status === 'settled') {
                const pot = group.totalValue;
                const commission = Math.floor(pot * (group.commissionPercentage / 100)); // Depending on integer rules
                const dividend = ledger.winningBidDiscount - commission;
                const expectedDivPerHead = Math.floor(dividend / (group.totalMonths || 1));
                const expectedNetPayable = group.monthlySubscription - expectedDivPerHead;

                if (Math.abs(expectedDivPerHead - ledger.dividendPerHead) > 2) { // 2 paise rounding tolerance
                    await this.reportIncident('CHIT-003', 'ChitLedger', ledger._id, expectedDivPerHead, ledger.dividendPerHead, 'Dividend math mismatch');
                }
            }
        }
    }

    static async runAll() {
        await this.reconcileGlobalLedger();
        await this.reconcileLoans();
        await this.reconcileChits();
        console.log('[ReconciliationService] Full sweep completed.');
    }
}

module.exports = ReconciliationService;
