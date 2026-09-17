require('dotenv').config();
const mongoose = require('mongoose');
const Loan = require('../models/Loan');
const FinancialLedgerService = require('../services/FinancialLedgerService');

async function reconcile(dryRun = true) {
    let session;
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        session = await mongoose.startSession();
        
        const duplicates = {
            '6aaa8b83fee00a8bb0ace708': [
                '6aabd11b1fc5429b390262d7',
                '6aabd1201fc5429b390262de',
                '6aabd2c11fc5429b39026384',
                '6aabd2c61fc5429b3902638e',
                '6aabd2db1fc5429b390263be',
                '6aabd2df1fc5429b390263cb'
            ],
            '6aaa9f354a72eec9ea0f8c62': [
                '6aabd2681fc5429b39026313',
                '6aabd26d1fc5429b3902631b',
                '6aabd28f1fc5429b39026339',
                '6aabd2931fc5429b39026344',
                '6aabd29f1fc5429b3902635d'
            ]
        };

        let totalReversals = 0;

        await session.withTransaction(async () => {
            for (const [loanId, txIds] of Object.entries(duplicates)) {
                console.log('\n==================================================');
                console.log('RECONCILING LOAN:', loanId);
                const loan = await Loan.findById(loanId).session(session);
                if (!loan) continue;

                for (const txId of txIds) {
                    console.log('  --- Reversing Transaction:', txId, '---');
                    
                    const { originalTx, reversalTx } = await FinancialLedgerService.reverseTransaction(loan, txId, 'SYSTEM_ADMIN', new Date());
                    
                    console.log('  Original ID:', originalTx._id.toString());
                    console.log('  Original canonical deltas: Principal:', originalTx.principalAllocationPaise || 0, 'Interest:', originalTx.interestAllocationPaise || 0, 'Fees:', originalTx.feesAllocationPaise || 0);
                    
                    console.log('  Reversal canonical deltas: Principal:', reversalTx.principalAllocationPaise, 'Interest:', reversalTx.interestAllocationPaise, 'Fees:', reversalTx.feesAllocationPaise);
                    
                    console.log('  -> Resulting Derived Balances:');
                    console.log('     Principal:', loan.principalOutstandingPaise);
                    console.log('     Interest:', loan.interestOutstandingPaise);
                    console.log('     Fees:', loan.feesOutstandingPaise);
                    console.log('     Total Outstanding:', loan.totalPayablePaise);
                    
                    totalReversals++;
                }
                
                if (!dryRun) {
                    await loan.save({ session });
                }
            }
            
            // To prove atomicity during dry run, we will intentionally throw an error if dryRun is true
            // but actually, withTransaction will commit if we don't throw, but if dryRun=true we want to ABORT it.
            if (dryRun) {
                throw new Error('DRY RUN COMPLETE - INTENTIONALLY ABORTING TRANSACTION');
            }
        });

        console.log('\n? Reconciliation Execution Completed. Total reversals created:', totalReversals);
    } catch(err) {
        if (err.message === 'DRY RUN COMPLETE - INTENTIONALLY ABORTING TRANSACTION') {
            console.log('\n? DRY RUN COMPLETE. Mongo transaction successfully aborted.');
            console.log('Total reversals that WOULD be created:', 11);
        } else {
            console.error('\n? RECONCILIATION FAILED. Transaction aborted.', err);
        }
    } finally {
        if (session) session.endSession();
        await mongoose.disconnect();
    }
}

// Run as dryRun by default for safety
reconcile(true);

