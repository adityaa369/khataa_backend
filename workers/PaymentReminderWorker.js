const Loan = require('../models/Loan');
const EventDispatcher = require('../utils/EventDispatcher');
const logger = require('../utils/logger');
const { generateRepaymentTimeline } = require('../utils/repaymentSchedule');

class PaymentReminderWorker {
    static async runDailyReminders(currentDate = new Date()) {
        logger.info(\[PaymentReminderWorker] Starting daily reminder run for \\);
        
        let reminderCount = 0;

        try {
            const activeLoans = await Loan.find({ status: { $in: ['active', 'due_soon', 'overdue'] } });

            for (const loan of activeLoans) {
                const timelineResp = generateRepaymentTimeline(loan);
                if (!timelineResp.trackingEnabled) continue;

                const timeline = timelineResp.data.timeline;
                
                const currentPeriod = timeline.find(p => p.status === 'unpaid' || p.status === 'partially_paid');
                
                if (!currentPeriod) continue;

                const periodEnd = new Date(currentPeriod.periodEnd);
                const diffTime = periodEnd - currentDate;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                let nudgeType = null;
                if (diffDays === 3) nudgeType = 'due_in_3';
                else if (diffDays === 1) nudgeType = 'due_in_1';
                else if (diffDays === -1) nudgeType = 'overdue_1';
                else if (diffDays === -7) nudgeType = 'overdue_7';

                if (nudgeType) {
                    const deterministicEventId = \PAYMENT_NUDGE-\-period\-\\;
                    
                    try {
                        const amountRupees = ((currentPeriod.expectedAmountPaise || 0) / 100).toFixed(2);
                        let title = 'Payment Due Soon';
                        let body = \Your payment of ?\ for month \ is due in \ days.\;
                        
                        if (diffDays < 0) {
                            title = 'Payment Overdue';
                            body = \Your payment of ?\ for month \ is overdue.\;
                        }

                        // EventDispatcher automatically handles idempotency and suppresses duplicates!
                        await EventDispatcher.dispatch({
                            eventType: 'PAYMENT_NUDGE',
                            aggregateType: 'LOAN',
                            aggregateId: loan._id.toString(),
                            idempotencyKey: deterministicEventId,
                            recipientUserId: loan.borrower.toString(),
                            payload: {
                                title,
                                body,
                                type: 'PAYMENT_NUDGE',
                                loanId: loan._id.toString(),
                                periodIndex: String(currentPeriod.periodIndex),
                                amountPaise: String(currentPeriod.expectedAmountPaise),
                                deepLink: \khaata://loans/\\
                            }
                        });

                        reminderCount++;
                        
                        if (diffDays <= 3 && diffDays > 0 && loan.status !== 'due_soon') {
                            loan.status = 'due_soon';
                            await loan.save();
                        } else if (diffDays <= 0 && loan.status !== 'overdue') {
                            loan.status = 'overdue';
                            await loan.save();
                        }
                    } catch (e) {
                        logger.error(\[PaymentReminderWorker] Failed to process reminder for loan \: \\);
                    }
                }
            }

            logger.info(\[PaymentReminderWorker] Completed daily reminder run. Dispatched \ reminders.\);
            return { success: true, remindersSent: reminderCount };
        } catch (e) {
            logger.error(\[PaymentReminderWorker] Fatal error: \\);
            throw e;
        }
    }
}

module.exports = PaymentReminderWorker;
