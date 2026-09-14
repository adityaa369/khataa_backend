const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const assert = require('assert');

const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const TransactionIntent = require('../models/TransactionIntent');
const FinancialLedgerService = require('../services/FinancialLedgerService');
const InterestAccrualCalculator = require('../services/InterestAccrualCalculator');

describe('BATCH 2B: 16-Invariant Final Verification', function () {
    this.timeout(60000);
    let replSet;

    before(async () => {
        replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
        await mongoose.connect(replSet.getUri(), { useNewUrlParser: true, useUnifiedTopology: true });
    });

    after(async () => {
        await mongoose.disconnect();
        await replSet.stop();
    });

    beforeEach(async () => {
        await mongoose.connection.db.dropDatabase();
    });

    async function createActiveLoan(intentId, opts = {}) {
        const amountPaise = opts.amountPaise || 10000000;
        const months = opts.months || 12;
        const rate = opts.rate || 2;
        const loanStartDate = opts.loanStartDate || null;

        const doc = {
            lender: 'L1', borrower: 'B1', borrowerPhone: '9999999999',
            borrowerName: 'B1', borrowerAadhar: '111',
            loanType: opts.loanType || 'interest_credit', amount: amountPaise / 100,
            amountPaise, interestRate: rate, durationMonths: months,
            status: 'pending_approval'
        };
        if (opts.endDate) doc.endDate = opts.endDate;

        const loan = await Loan.create(doc);
        await TransactionIntent.create({
            intentId, loanId: loan._id, action: 'ACCEPT_LOAN', status: 'PENDING',
            expiresAt: new Date(Date.now() + 86400000 * 365),
            userId: 'B1', payload: { amountPaise }
        });
        let activeLoan = (await FinancialLedgerService.acceptLoan(loan._id, 'B1', intentId)).loan;

        if (loanStartDate) {
            await Loan.collection.updateOne({ _id: activeLoan._id }, { $set: { createdAt: loanStartDate } });
            activeLoan = await Loan.findById(activeLoan._id);
        }
        return activeLoan;
    }

    // -------------------------------------------------------------------------
    // Rule 1: INTEREST TYPE
    // -------------------------------------------------------------------------
    it('1. INTEREST TYPE: Sets interest_credit to REDUCING_BALANCE', async () => {
        const loan = await createActiveLoan('INT_1');
        // assert creditType removed
        assert.strictEqual(loan.agreementSnapshot.interestMethod, 'REDUCING_BALANCE');
    });

    // -------------------------------------------------------------------------
    // Rule 2: RATE
    // -------------------------------------------------------------------------
    it('2. RATE: 2% monthly -> 200 bps monthly', async () => {
        const loan = await createActiveLoan('INT_2', { rate: 2.0 });
        assert.strictEqual(loan.agreementSnapshot.monthlyInterestRateBps, 200, 'Monthly BPS should be 200');
        // nominalAnnualRateBps = 2400 is used by the calculator. Let's verify by calculating 1 day interest:
        // 10M * 24% * 1/365 = 6575.34 paise
        const { roundedInterestPaise } = InterestAccrualCalculator.calculate(loan, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
        assert.strictEqual(roundedInterestPaise, 6575, 'Calculated interest implies 2400 annualized bps');
    });

    // -------------------------------------------------------------------------
    // Rule 3: DAILY ACCRUAL
    // -------------------------------------------------------------------------
    it('3. DAILY ACCRUAL: Accrues against principalOutstandingPaise', async () => {
        const loan = await createActiveLoan('INT_3');
        // Set outstanding differently from original expected (10M -> 5M)
        await Loan.collection.updateOne({ _id: loan._id }, { $set: { principalOutstandingPaise: 5000000 } });
        const refreshed = await Loan.findById(loan._id);
        const { roundedInterestPaise } = InterestAccrualCalculator.calculate(refreshed, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
        // 5M * 24% * 1/365 = 3287.67 paise
        assert.strictEqual(roundedInterestPaise, 3288, 'Calculated on principalOutstandingPaise');
    });

    // -------------------------------------------------------------------------
    // Rule 4: PRE-PAYMENT ACCRUAL
    // -------------------------------------------------------------------------
    it('4. PRE-PAYMENT ACCRUAL: Accrues through exact effectiveAt before payment', async () => {
        const loanStart = new Date('2026-01-01T00:00:00Z');
        const paymentDate = new Date('2026-01-05T00:00:00Z'); // 4 days elapsed
        const loan = await createActiveLoan('INT_4', { loanStartDate: loanStart });
        
        await FinancialLedgerService.recordPayment(loan._id, 1000, 'L1', null, paymentDate);
        
        const txs = await Transaction.find({ loanId: loan._id, type: 'INTEREST_ACCRUED' });
        assert.strictEqual(txs.length, 1, 'Pre-payment accrual created');
        // 10M * 24% * 4/365 = 26301.37
        assert.strictEqual(txs[0].interestDeltaPaise, 26301, 'Accrued for exactly 4 days up to effectiveAt');
    });

    // -------------------------------------------------------------------------
    // Rule 5: EARLY-PAYMENT INVARIANT
    // -------------------------------------------------------------------------
    it('5. EARLY-PAYMENT INVARIANT: futureInterest(B) < futureInterest(A)', async () => {
        const loanStart = new Date('2026-01-01T00:00:00Z');
        const payDay1 = new Date('2026-01-31T00:00:00Z');
        const payDay2 = new Date('2026-03-02T00:00:00Z');

        const loanA = await createActiveLoan('INT_5A', { loanStartDate: loanStart });
        const loanB = await createActiveLoan('INT_5B', { loanStartDate: loanStart });

        // Period 1
        await FinancialLedgerService.recordPayment(loanA._id, 1030593, 'L1', null, payDay1);
        await FinancialLedgerService.recordPayment(loanB._id, 5000000, 'L1', null, payDay1);

        // Period 2
        const resA2 = await FinancialLedgerService.recordPayment(loanA._id, 1014155, 'L1', null, payDay2);
        const resB2 = await FinancialLedgerService.recordPayment(loanB._id, 935854, 'L1', null, payDay2);

        const interestA = -resA2.transaction.interestDeltaPaise;
        const interestB = -resB2.transaction.interestDeltaPaise;
        assert.ok(interestB < interestA, `B (${interestB}) < A (${interestA})`);
    });

    // -------------------------------------------------------------------------
    // Rule 6: NO INTEREST-ON-INTEREST
    // -------------------------------------------------------------------------
    it('6. NO INTEREST-ON-INTEREST: unpaid interest does not compound', async () => {
        const loanStart = new Date('2026-01-01T00:00:00Z');
        const loan = await createActiveLoan('INT_6', { loanStartDate: loanStart });
        
        const day30 = new Date('2026-01-31T00:00:00Z');
        await FinancialLedgerService.recordPayment(loan._id, 1, 'L1', null, day30);
        const l1 = await Loan.findById(loan._id);
        const accrued1 = l1.interestOutstandingPaise;
        assert.ok(accrued1 > 10000, 'Interest accrued');
        
        const day60 = new Date('2026-03-02T00:00:00Z');
        await FinancialLedgerService.recordPayment(loan._id, 1, 'L1', null, day60);
        const l2 = await Loan.findById(loan._id);
        const accrued2 = l2.interestOutstandingPaise;
        
        const addedPeriod2 = accrued2 - accrued1;
        // Period 1 and 2 are 30 days. P is same.
        assert.ok(Math.abs(addedPeriod2 - accrued1) < 1000, 'Second period interest is ~identical, no compounding');
    });

    // -------------------------------------------------------------------------
    // Rule 7: WATERFALL
    // -------------------------------------------------------------------------
    it('7. WATERFALL: fees -> accrued interest -> principal', async () => {
        const loan = await createActiveLoan('INT_7');
        // Force state
        await Loan.collection.updateOne({ _id: loan._id }, { 
            $set: { feesOutstandingPaise: 50, interestOutstandingPaise: 100, principalOutstandingPaise: 1000, createdAt: new Date() } 
        });
        // We pay 120. Should cover 50 fees, 70 interest. Principal unchanged.
        const res = await FinancialLedgerService.recordPayment(loan._id, 120, 'L1', null, new Date());
        assert.strictEqual(res.transaction.feeDeltaPaise, -50); // fix
        assert.strictEqual(res.transaction.interestDeltaPaise, -70);
        assert.strictEqual(res.transaction.principalDeltaPaise, -0);
        
        const l2 = await Loan.findById(loan._id);
        assert.strictEqual(l2.feesOutstandingPaise, 0);
        assert.strictEqual(l2.interestOutstandingPaise, 30);
        assert.strictEqual(l2.principalOutstandingPaise, 1000);
    });

    // -------------------------------------------------------------------------
    // Rule 8: MULTIPLE PAYMENTS
    // -------------------------------------------------------------------------
    it('8. MULTIPLE PAYMENTS: interest recalculates correctly across mid-period payments', async () => {
        const loanStart = new Date('2026-01-01T00:00:00Z');
        const loan = await createActiveLoan('INT_8', { loanStartDate: loanStart });
        
        // P1: Jan 10
        const res1 = await FinancialLedgerService.recordPayment(loan._id, 2000000, 'L1', null, new Date('2026-01-10T00:00:00Z'));
        assert.strictEqual(res1.transaction.interestDeltaPaise, -59178); // 9 days
        
        // P2: Jan 20
        const res2 = await FinancialLedgerService.recordPayment(loan._id, 2000000, 'L1', null, new Date('2026-01-20T00:00:00Z'));
        // Principal was heavily reduced
        assert.ok(-res2.transaction.interestDeltaPaise < 59178, 'P2 interest is smaller');
    });

    // -------------------------------------------------------------------------
    // Rule 9: UNDERPAYMENT / DEFICIT
    // -------------------------------------------------------------------------
    it('9. UNDERPAYMENT / DEFICIT: min deficit tracked, not added to balances', async () => {
        const loan = await createActiveLoan('INT_9');
        // Backdate to avoid immediate accrual (use current time so interest=0)
        const cpp = loan.agreementSnapshot.constantPrincipalPortionPaise;
        const payment = cpp - 1000;
        const res = await FinancialLedgerService.recordPayment(loan._id, payment, 'L1', null, new Date());
        
        const l2 = res.loan;
        assert.strictEqual(l2.minimumDeficitPaise, 1000, 'Deficit exactly 1000 recorded');
        // 10M - (cpp - 1000)
        assert.strictEqual(l2.principalOutstandingPaise, 10000000 - payment, 'Financial balance unaffected by deficit');
    });

    // -------------------------------------------------------------------------
    // Rule 10: CPP ROUNDING
    // -------------------------------------------------------------------------
    it('10. CPP ROUNDING: handles non-divisible principal mathematically', async () => {
        // 1,000,000 paise over 3 months -> CPP = 333,333
        const loanStart = new Date('2026-01-01T00:00:00Z');
        let loan = await createActiveLoan('INT_10', { amountPaise: 1000000, months: 3, loanStartDate: loanStart });
        assert.strictEqual(loan.agreementSnapshot.constantPrincipalPortionPaise, 333333);
    });

    // -------------------------------------------------------------------------
    // Rule 11: ADD CREDIT
    // -------------------------------------------------------------------------
    it('11. ADD CREDIT: requires intent, updates principal, recalculates CPP', async () => {
        const loanStart = new Date();
        const end = new Date(loanStart.getTime() + 10 * 30 * 24 * 3600 * 1000);
        let loan = await createActiveLoan('INT_11', { amountPaise: 1000000, months: 10, endDate: end });
        const initialCPP = loan.agreementSnapshot.constantPrincipalPortionPaise;
        
        await TransactionIntent.create({
            intentId: 'INT_AC', loanId: loan._id, action: 'ADD_CREDIT', status: 'PENDING',
            expiresAt: new Date(Date.now() + 86400000 * 10), userId: 'L1', payload: { amountPaise: 2000000 }
        });
        const res = await FinancialLedgerService.addCredit(loan._id, 2000000, 'L1', 'INT_AC', new Date());
        loan = res.loan;
        assert.strictEqual(loan.principalOutstandingPaise, 3000000);
        assert.ok(loan.agreementSnapshot.constantPrincipalPortionPaise > initialCPP);
    });

    // -------------------------------------------------------------------------
    // Rule 12: ADD CREDIT + PARTIAL ACCRUAL
    // -------------------------------------------------------------------------
    it('12. ADD CREDIT + PARTIAL ACCRUAL: pre-accrues before mutating', async () => {
        const loanStart = new Date('2026-01-01T00:00:00Z');
        let loan = await createActiveLoan('INT_12', { loanStartDate: loanStart });
        
        await TransactionIntent.create({
            intentId: 'INT_12_C', loanId: loan._id, action: 'ADD_CREDIT', status: 'PENDING',
            expiresAt: new Date(Date.now() + 86400000 * 365), userId: 'L1', payload: { amountPaise: 1000000 }
        });
        const addDate = new Date('2026-01-10T00:00:00Z'); // 9 days elapsed
        const res = await FinancialLedgerService.addCredit(loan._id, 1000000, 'L1', 'INT_12_C', addDate);
        
        const txs = await Transaction.find({ loanId: loan._id, type: 'INTEREST_ACCRUED' });
        assert.strictEqual(txs.length, 1, 'Pre-accrual created on add credit');
        assert.strictEqual(txs[0].interestDeltaPaise, 59178); // 10M * 24% * 9/365
    });

    // -------------------------------------------------------------------------
    // Rule 13: OVERPAYMENT
    // -------------------------------------------------------------------------
    it('13. OVERPAYMENT: 1 paisa over total outstanding fails cleanly', async () => {
        const loan = await createActiveLoan('INT_13', { amountPaise: 100000 });
        try {
            await FinancialLedgerService.recordPayment(loan._id, 100001, 'L1', null, new Date());
            assert.fail('Should reject');
        } catch(e) {
            assert.ok(e.message.includes('OVERPAYMENT_REJECTED'));
        }
        const txs = await Transaction.find({ loanId: loan._id, type: 'PAYMENT' });
        assert.strictEqual(txs.length, 0, 'No payment transaction created');
    });

    // -------------------------------------------------------------------------
    // Rule 14: MATURITY
    // -------------------------------------------------------------------------
    it('14. MATURITY: Interest continues', async () => {
        const loanStart = new Date('2026-01-01T00:00:00Z');
        const endDate = new Date('2026-02-01T00:00:00Z');
        let loan = await createActiveLoan('INT_14', { loanStartDate: loanStart, endDate });
        
        const postMaturityPay = new Date('2026-03-01T00:00:00Z');
        const res = await FinancialLedgerService.recordPayment(loan._id, 1, 'L1', null, postMaturityPay);
        
        const txs = await Transaction.find({ loanId: loan._id, type: 'INTEREST_ACCRUED' });
        assert.ok(txs.length > 0);
        assert.ok(txs[0].interestDeltaPaise > 0, 'Interest continued accruing past maturity');
    });

    // -------------------------------------------------------------------------
    // Rule 15: CLOSURE
    // -------------------------------------------------------------------------
    it('15. CLOSURE: Final accrual through exact effectiveAt, no borrower intent required', async () => {
        const loanStart = new Date('2026-01-01T00:00:00Z');
        let loan = await createActiveLoan('INT_15', { loanStartDate: loanStart });
        
        const closeDate = new Date('2026-01-05T00:00:00Z'); // 4 days elapsed
        const res = await FinancialLedgerService.writeOffAndClose(loan._id, 'L1', null, closeDate);
        assert.ok(res.transaction);
        
        const txs = await Transaction.find({ loanId: loan._id, type: 'INTEREST_ACCRUED' });
        assert.strictEqual(txs.length, 1);
        assert.strictEqual(txs[0].interestDeltaPaise, 26301); // exact 4-day accrual
        
        const finalLoan = await Loan.findById(loan._id);
        assert.strictEqual(finalLoan.status, 'closed');
    });

    // -------------------------------------------------------------------------
    // Rule 16: RECONCILIATION / LEDGER
    // -------------------------------------------------------------------------
    it('16. RECONCILIATION: materialized balances match sum of ledger deltas', async () => {
        const loanStart = new Date('2026-01-01T00:00:00Z');
        let loan = await createActiveLoan('INT_16', { loanStartDate: loanStart });
        
        await FinancialLedgerService.recordPayment(loan._id, 500000, 'L1', null, new Date('2026-01-10T00:00:00Z'));
        
        await TransactionIntent.create({
            intentId: 'INT_16_C', loanId: loan._id, action: 'ADD_CREDIT', status: 'PENDING',
            expiresAt: new Date(Date.now() + 86400000 * 365), userId: 'L1', payload: { amountPaise: 1000000 }
        });
        await FinancialLedgerService.addCredit(loan._id, 1000000, 'L1', 'INT_16_C', new Date('2026-01-20T00:00:00Z'));
        
        await FinancialLedgerService.writeOffAndClose(loan._id, 'L1', null, new Date('2026-02-01T00:00:00Z'));
        
        const finalLoan = await Loan.findById(loan._id);
        const txs = await Transaction.find({ loanId: loan._id });
        
        let sumP = 0, sumI = 0, sumF = 0;
        for (const tx of txs) {
            sumP += (tx.principalDeltaPaise || 0);
            sumI += (tx.interestDeltaPaise || 0);
            sumF += (tx.feesDeltaPaise || 0);
        }
        
        assert.strictEqual(finalLoan.principalOutstandingPaise, sumP);
        assert.strictEqual(finalLoan.interestOutstandingPaise, sumI);
        assert.strictEqual(finalLoan.feesOutstandingPaise, sumF);
    });
});
