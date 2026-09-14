const { fireAlert } = require('../utils/AlertManager');
const mongoose = require('mongoose');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

class ReconciliationEngine {
    static async runReconciliation() {
        const loans = await Loan.find({ ledgerVersion: 2, financialStatus: 'NORMAL' });
        const results = { verified: 0, frozen: 0 };

        for (const loan of loans) {
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

            const isMatch = (
                ledgerP === loan.principalOutstandingPaise &&
                ledgerI === loan.interestOutstandingPaise &&
                ledgerF === loan.feesOutstandingPaise
            );
            
            const isNegative = (
                ledgerP < 0 || loan.principalOutstandingPaise < 0 ||
                ledgerI < 0 || loan.interestOutstandingPaise < 0 ||
                ledgerF < 0 || loan.feesOutstandingPaise < 0
            );

            if (!isMatch || isNegative) {
                if (!isMatch) {
                    await fireAlert('RECONCILIATION_MISMATCH', loan._id.toString(), {
                        loanId: loan._id.toString(),
                        principalMismatch: ledgerP !== loan.principalOutstandingPaise,
                        interestMismatch: ledgerI !== loan.interestOutstandingPaise,
                        feeMismatch: ledgerF !== loan.feesOutstandingPaise,
                        subsystem: 'ReconciliationEngine'
                    });
                }
                if (isNegative) {
                    await fireAlert('NEGATIVE_BALANCE', loan._id.toString(), {
                        loanId: loan._id.toString(),
                        subsystem: 'ReconciliationEngine'
                    });
                }
                
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
