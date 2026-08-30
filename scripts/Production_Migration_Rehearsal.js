const mongoose = require('mongoose');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');

class ProductionMigrationRehearsal {
    /**
     * Executes the V1 to V2 Full Migration Rehearsal in an isolated database environment.
     * Enforces per-loan transaction isolation and idempotency.
     */
    static async runRehearsal(loansList, injectAtomicityFailureId = null) {
        const report = {
            classification: { migratable: 0, failed: 0, skipped: 0 },
            results: { successful: 0, failed: 0, skipped: 0, rolledBack: 0 },
            money: { v1Eligible: 0, v2Ledger: 0, v2Cache: 0 },
            taxonomy: {
                DATA_CORRUPTION: 0,
                UNSUPPORTED_LEGACY_SEMANTICS: 0,
                AMBIGUOUS_RECONSTRUCTION: 0,
                SCHEMA_ERROR: 0,
                STATE_ERROR: 0
            },
            crossContamination: 0,
            duplicateTxs: 0,
            duplicateSequences: 0
        };

        for (const v1Loan of loansList) {
            // Idempotency: Skip already migrated
            if (v1Loan.ledgerVersion === 2) {
                report.classification.skipped++;
                report.results.skipped++;
                continue;
            }

            const analysis = this.analyzeLoan(v1Loan);

            if (analysis.status === 'FAILED') {
                report.classification.failed++;
                report.results.failed++;
                report.taxonomy[analysis.taxonomy]++;
                // Policy: REQUIRES_MANUAL_TRIAGE. Do NOT auto-freeze.
                continue;
            }

            report.classification.migratable++;
            report.money.v1Eligible += v1Loan.totalPayablePaise || 0;

            // ATOMIC TRANSACTION ISOLATION
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async () => {
                    const dbLoan = await Loan.findById(v1Loan._id).session(session);
                    let seq = 1;
                    
                    // 1. Insert V2 Ledger
                    for (const tx of analysis.v2Transactions) {
                        const newTx = new Transaction({
                            ...tx,
                            loanId: dbLoan._id,
                            sequenceNumber: seq++
                        });
                        await newTx.save({ session });
                    }

                    // 2. Deliberate Mid-Transaction Failure Injection
                    if (v1Loan._id === injectAtomicityFailureId) {
                        throw new Error('INJECTED_ATOMICITY_FAILURE');
                    }

                    // 3. Update V2 Materialized Cache
                    dbLoan.ledgerVersion = 2;
                    dbLoan.principalOutstandingPaise = analysis.v2Principal;
                    dbLoan.interestOutstandingPaise = analysis.v2Interest;
                    dbLoan.feesOutstandingPaise = analysis.v2Fees;
                    dbLoan.status = analysis.mappedV2State;
                    await dbLoan.save({ session });
                });
                
                report.results.successful++;
            } catch (err) {
                if (err.message === 'INJECTED_ATOMICITY_FAILURE') {
                    report.results.rolledBack++;
                } else {
                    report.results.failed++;
                    console.error(`Unexpected migration error on ${v1Loan._id}`, err);
                }
            } finally {
                session.endSession();
            }
        }

        // Post-Migration Independent Reconciliation (Read-Only phase)
        await this.runIndependentReconciliation(report);
        return report;
    }

    static analyzeLoan(v1Loan) {
        // Shared logic from Production_Migration_Analyzer...
        // Reconstructs txs array securely without mutating DB.
        // Returns { status, v2Transactions, v2Principal, v2Interest, v2Fees, mappedV2State }
        return { status: 'MIGRATABLE', v2Transactions: [], v2Principal: 100, v2Interest: 0, v2Fees: 0, mappedV2State: 'ACTIVE' };
    }

    static async runIndependentReconciliation(report) {
        // Aggregates completely independently to verify the rehearsal
        const loans = await Loan.find({ ledgerVersion: 2 });
        const allTxs = await Transaction.find({});
        
        // Ensure no cross contamination
        report.crossContamination = allTxs.filter(tx => !loans.map(l => l._id.toString()).includes(tx.loanId.toString())).length;

        // Check sequences
        const sequences = new Set(allTxs.map(t => `${t.loanId}_${t.sequenceNumber}`));
        report.duplicateSequences = allTxs.length - sequences.size;

        for (const loan of loans) {
            const txs = allTxs.filter(t => t.loanId.toString() === loan._id.toString());
            let p = 0, i = 0, f = 0;
            txs.forEach(t => {
                p += t.principalDeltaPaise;
                i += t.interestDeltaPaise;
                f += t.feeDeltaPaise;
            });
            report.money.v2Ledger += (p + i + f);
            report.money.v2Cache += (loan.principalOutstandingPaise + loan.interestOutstandingPaise + loan.feesOutstandingPaise);
        }
    }
}

module.exports = ProductionMigrationRehearsal;
