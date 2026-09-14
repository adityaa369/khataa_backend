// scripts/migrate-loan-money-to-paise.js
require('dotenv').config();
const mongoose = require('mongoose');
const Loan = require('../models/Loan');

async function migrate() {
    const isDryRun = !process.argv.includes('--execute');
    
    console.log('\n=============================================');
    console.log('?? SPRINT 4.2 FINANCIAL MIGRATION: RUPEES TO PAISE');
    console.log(`MODE: ${isDryRun ? 'DRY RUN (No database mutations)' : 'EXECUTE (Mutating database)'}`);
    console.log('=============================================\n');

    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        console.log('[DB] Connected.');

        const loans = await Loan.find({});
        
        let scanned = 0;
        let convertible = 0;
        let manualReview = 0;
        let invalidValues = 0;
        let reconMismatches = 0;
        let alreadyMigrated = 0;

        const roundToPaise = (val) => {
            if (val === undefined || val === null) return 0;
            return Math.round(Number(val) * 100);
        };

        const isInvalid = (val) => {
            if (val === undefined || val === null) return false;
            const n = Number(val);
            return isNaN(n) || !isFinite(n) || n < 0;
        };

        for (const loan of loans) {
            scanned++;

            // If loan is completely migrated and has new fields, skip it
            if (loan.amountPaise !== undefined && loan.totalPayablePaise !== undefined) {
                alreadyMigrated++;
                continue;
            }

            let needsReview = false;
            let invalid = false;
            let mismatch = false;

            // 1. Invalid checks
            if (isInvalid(loan.amount) || isInvalid(loan.emiAmount) || isInvalid(loan.totalPayable) || isInvalid(loan.paidAmount)) {
                invalid = true;
                invalidValues++;
            }

            // 2. Deterministic conversion
            const amountPaise = roundToPaise(loan.amount);
            const emiAmountPaise = roundToPaise(loan.emiAmount);
            const totalPayablePaise = roundToPaise(loan.totalPayable);
            const paidAmountPaise = roundToPaise(loan.paidAmount);

            // 3. Reconciliation rules
            // Usually, paidAmount + outstanding = totalPayable. Since we don't have outstanding explicitly, 
            // we just ensure paidAmount <= totalPayable.
            if (paidAmountPaise > totalPayablePaise) {
                mismatch = true;
                reconMismatches++;
            }

            if (invalid || mismatch) {
                needsReview = true;
                manualReview++;
            } else {
                convertible++;
            }

            // 4. Update (If execute)
            if (!isDryRun && !needsReview) {
                loan.amountPaise = amountPaise;
                loan.emiAmountPaise = emiAmountPaise;
                loan.totalPayablePaise = totalPayablePaise;
                loan.paidAmountPaise = paidAmountPaise;

                // Migrate sub-transactions
                if (loan.transactions && loan.transactions.length > 0) {
                    loan.transactions.forEach(tx => {
                        if (tx.amount !== undefined && tx.amountPaise === undefined) {
                            tx.amountPaise = roundToPaise(tx.amount);
                        }
                    });
                }
                await loan.save();
            }
        }

        console.log(`Loans scanned:               ${scanned}`);
        console.log(`Already migrated:            ${alreadyMigrated}`);
        console.log(`Loans convertible:           ${convertible}`);
        console.log(`Loans requiring manual rev:  ${manualReview}`);
        console.log(`Invalid monetary values:     ${invalidValues}`);
        console.log(`Reconciliation mismatches:   ${reconMismatches}`);
        console.log('\n---------------------------------------------');
        if (isDryRun) {
            console.log('Migration NOT executed. Run with --execute to apply.');
        } else {
            console.log('Migration EXECUTED successfully.');
        }
        console.log('=============================================\n');

        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
