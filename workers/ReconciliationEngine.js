const mongoose = require('mongoose');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');

class ReconciliationEngine {
    /**
     * Independently aggregates the immutable ledger and compares it against the materialized cache.
     * Drops the FROZEN hammer on any discrepancy.
     */
    static async runReconciliation() {
        const loans = await Loan.find({ ledgerVersion: 2, financialStatus: 'NORMAL' });
        const results = { verified: 0, frozen: 0 };

        for (const loan of loans) {
            // 1. Independent Aggregation
            const [agg] = await Transaction.aggregate([
                { $match: { loanId: loan._id } },
                { 
                    $group: { 
                        _id: null, 
                        totalP: { $sum: "$principalDeltaPaise" }, 
                        totalI: { $sum: "$interestDeltaPaise" }, 
                        totalF: { $sum: "$feeDeltaPaise" } 
                    } 
                }
            ]);

            const ledgerP = agg ? agg.totalP : 0;
            const ledgerI = agg ? agg.totalI : 0;
            const ledgerF = agg ? agg.totalF : 0;

            // 2. Exact Component Comparison
            const isMatch = (
                ledgerP === loan.principalOutstandingPaise &&
                ledgerI === loan.interestOutstandingPaise &&
                ledgerF === loan.feesOutstandingPaise
            );

            // 3. Freeze on 1-Paise Mismatch
            if (!isMatch) {
                console.error(`[CRITICAL] Reconciliation Failure Loan ${loan._id}. Ledger: ${ledgerP}/${ledgerI}/${ledgerF} | Cache: ${loan.principalOutstandingPaise}/${loan.interestOutstandingPaise}/${loan.feesOutstandingPaise}`);
                
                // Freeze atomically
                await Loan.updateOne(
                    { _id: loan._id, financialStatus: 'NORMAL' },
                    { $set: { financialStatus: 'FROZEN' } }
                );
                results.frozen++;
            } else {
                results.verified++;
            }
        }
        return results;
    }
}

module.exports = ReconciliationEngine;
