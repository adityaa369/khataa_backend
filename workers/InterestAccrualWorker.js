const mongoose = require('mongoose');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const FinancialLedgerService = require('../services/FinancialLedgerService');
const { asyncLocalStorage, updateTraceContext } = require('../utils/asyncContext');
const logger = require('../utils/logger');
const crypto = require('crypto');

class InterestAccrualWorker {
    static async runDailyAccrual(targetDate = new Date()) {
        const jobId = crypto.randomUUID();
        const start = Date.now();
        
        return new Promise((resolve) => {
            asyncLocalStorage.run({ requestId: jobId, jobName: 'interest_accrual' }, async () => {
                logger.info({ type: 'worker_start' });
                const results = { successful: 0, skipped: 0, failed: 0 };
                
                try {
                    const loans = await Loan.find({
                        ledgerVersion: 2,
                        financialStatus: 'NORMAL',
                        status: { $in: ['active', 'overdue', 'due_soon'] },
                        'agreementSnapshot.interestMethod': 'SIMPLE_ORIGINAL_PRINCIPAL'
                    });

                    for (const loan of loans) {
                        try {
                            const lastTx = await Transaction.findOne({
                                loanId: loan._id,
                                type: 'INTEREST_ACCRUED'
                            }).sort({ accrualEnd: -1 });

                            const startDate = lastTx ? lastTx.accrualEnd : loan.createdAt;
                            
                            const istFormatter = new Intl.DateTimeFormat('en-US', {
                                timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
                            });
                            const [{value: mm}, , {value: dd}, , {value: yyyy}] = istFormatter.formatToParts(targetDate);
                            const endDate = new Date(`${yyyy}-${mm}-${dd}T00:00:00+05:30`);

                            if (endDate.getTime() <= startDate.getTime()) {
                                results.skipped++;
                                continue;
                            }

                            const sDateStr = startDate.toISOString().split('T')[0];
                            const eDateStr = endDate.toISOString().split('T')[0];
                            const periodId = `ACCRUAL_${sDateStr}_${eDateStr}`;

                            // Execute in isolated context per loan to avoid bleeding
                            await new Promise((loanResolve) => {
                                asyncLocalStorage.run({ requestId: jobId, jobName: 'interest_accrual', loanId: loan._id.toString(), idempotencyKey: periodId }, async () => {
                                    try {
                                        const res = await FinancialLedgerService.accrueInterest(loan._id, periodId, startDate, endDate);
                                        if (res.success) {
                                            results.successful++;
                                            logger.info({
                                                type: 'accrual_event',
                                                transactionId: res.transaction ? res.transaction._id.toString() : undefined
                                            });
                                        } else {
                                            results.skipped++;
                                        }
                                    } catch (err) {
                                        logger.error({ type: 'operational_anomaly', anomaly: 'accrual_failed', message: err.message, severity: 'HIGH' });
                                        results.failed++;
                                    }
                                    loanResolve();
                                });
                            });

                        } catch (err) {
                            logger.error({ type: 'operational_anomaly', anomaly: 'accrual_loop_failed', message: err.message, loanId: loan._id.toString(), severity: 'HIGH' });
                            results.failed++;
                        }
                    }
                } catch(globalErr) {
                    logger.error({ type: 'operational_anomaly', anomaly: 'worker_fatal_error', message: globalErr.message, severity: 'CRITICAL' });
                } finally {
                    logger.info({
                        type: 'worker_complete',
                        durationMs: Date.now() - start,
                        processedCount: results.successful + results.skipped + results.failed,
                        successCount: results.successful,
                        failureCount: results.failed,
                        skippedCount: results.skipped
                    });
                    resolve(results);
                }
            });
        });
    }
}

module.exports = InterestAccrualWorker;
