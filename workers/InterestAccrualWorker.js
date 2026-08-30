const mongoose = require('mongoose');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const FinancialLedgerService = require('../services/FinancialLedgerService');

class InterestAccrualWorker {
    /**
     * Executes the daily interest accrual cron job.
     * Determines IST business boundaries and triggers FinancialLedgerService.
     */
    static async runDailyAccrual(targetDate = new Date()) {
        const loans = await Loan.find({
            ledgerVersion: 2,
            financialStatus: 'NORMAL',
            status: { $in: ['active', 'overdue', 'due_soon'] },
            'agreementSnapshot.interestMethod': 'SIMPLE_ORIGINAL_PRINCIPAL'
        });

        const results = { successful: 0, skipped: 0, failed: 0 };

        for (const loan of loans) {
            try {
                // 1. Determine last accrued date
                const lastTx = await Transaction.findOne({
                    loanId: loan._id,
                    type: 'INTEREST_ACCRUED'
                }).sort({ accrualEnd: -1 });

                const startDate = lastTx ? lastTx.accrualEnd : loan.createdAt;
                
                // 2. IST Business Boundary (Calculate to 00:00:00 IST of targetDate)
                // Normalize targetDate to IST start of day
                const istFormatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
                });
                const [{value: mm}, , {value: dd}, , {value: yyyy}] = istFormatter.formatToParts(targetDate);
                const endDate = new Date(`${yyyy}-${mm}-${dd}T00:00:00+05:30`);

                // 3. Prevent Future or Zero-Day Accruals
                if (endDate.getTime() <= startDate.getTime()) {
                    results.skipped++;
                    continue;
                }

                // 4. Generate Idempotency Key
                const sDateStr = startDate.toISOString().split('T')[0];
                const eDateStr = endDate.toISOString().split('T')[0];
                const periodId = `ACCRUAL_${sDateStr}_${eDateStr}`;

                // 5. Delegate safely to Level 2 FinancialLedgerService
                const res = await FinancialLedgerService.accrueInterest(loan._id, periodId, startDate, endDate);
                
                if (res.success) results.successful++;
                else results.skipped++;

            } catch (err) {
                console.error(`Accrual failed for Loan ${loan._id}:`, err);
                results.failed++;
            }
        }
        return results;
    }
}

module.exports = InterestAccrualWorker;
