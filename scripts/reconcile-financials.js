require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Loan = require('../models/Loan');
const LedgerEntry = require('../models/LedgerEntry');
const ChitFund = require('../models/ChitFund');
const ChitSubscription = require('../models/ChitSubscription');

async function runReconciliation() {
    console.log('\n=============================================');
    console.log('??? SPRINT 4.3 FINANCIAL RECONCILIATION SNAPSHOT');
    console.log('=============================================\n');

    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        console.log('[DB] Connected to DR Target.');

        const userCount = await User.countDocuments();
        const loanCount = await Loan.countDocuments();
        const ledgerCount = await LedgerEntry.countDocuments();
        const chitCount = await ChitFund.countDocuments();
        const subCount = await ChitSubscription.countDocuments();

        const loanAggr = await Loan.aggregate([
            {
                $group: {
                    _id: null,
                    totalAmountPaise: { $sum: "$amountPaise" },
                    totalPaidPaise: { $sum: "$paidAmountPaise" },
                    totalPayablePaise: { $sum: "$totalPayablePaise" }
                }
            }
        ]);

        const ledgerAggr = await LedgerEntry.aggregate([
            {
                $group: {
                    _id: "$type",
                    totalAmount: { $sum: "$amountPaise" }
                }
            }
        ]);

        let ledgerDebit = 0;
        let ledgerCredit = 0;
        ledgerAggr.forEach(l => {
            if (l._id === 'DEBIT') ledgerDebit = l.totalAmount;
            if (l._id === 'CREDIT') ledgerCredit = l.totalAmount;
        });

        const loanData = loanAggr[0] || { totalAmountPaise: 0, totalPaidPaise: 0, totalPayablePaise: 0 };

        console.log(`Users:                 ${userCount}`);
        console.log(`Loans:                 ${loanCount}`);
        console.log(`Ledger entries:        ${ledgerCount}`);
        console.log(`Chit funds:            ${chitCount}`);
        console.log(`Chit subscriptions:    ${subCount}`);
        console.log('---------------------------------------------');
        console.log(`Loan Amount Total:     ?${(loanData.totalAmountPaise / 100).toFixed(2)}`);
        console.log(`Loan Paid Total:       ?${(loanData.totalPaidPaise / 100).toFixed(2)}`);
        console.log(`Loan Payable Total:    ?${(loanData.totalPayablePaise / 100).toFixed(2)}`);
        console.log('---------------------------------------------');
        console.log(`Ledger Debit Total:    ?${(ledgerDebit / 100).toFixed(2)}`);
        console.log(`Ledger Credit Total:   ?${(ledgerCredit / 100).toFixed(2)}`);
        console.log('=============================================\n');

        // Verify Invariants (E.g. Ledger entries exist if loans exist)
        if (loanCount > 0 && ledgerCount === 0) {
            console.warn('[WARNING] Loans exist but Ledger is empty. Synchronization drift detected.');
        } else {
            console.log('[PASS] Structural reconciliation passed.');
        }

        process.exit(0);
    } catch (err) {
        console.error('Reconciliation failed:', err);
        process.exit(1);
    }
}

runReconciliation();
