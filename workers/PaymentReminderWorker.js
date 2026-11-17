const Loan = require('../models/Loan');
const User = require('../models/User');
const EventDispatcher = require('../utils/EventDispatcher');
const logger = require('../utils/logger');
const { generateRepaymentTimeline } = require('../utils/repaymentSchedule');

class PaymentReminderWorker {
    static async runDailyReminders(currentDate = new Date()) {
        logger.info(`[PaymentReminderWorker] Starting daily reminder run for ${currentDate.toISOString()}`);

        let reminderCount = 0;

        try {
            const activeLoans = await Loan.find({
                status: { $in: ['active', 'due_soon', 'overdue'] }
            });

            for (const loan of activeLoans) {
                const timelineResp = generateRepaymentTimeline(loan);
                if (!timelineResp.trackingEnabled || !timelineResp.data?.timeline) continue;

                const timeline = timelineResp.data.timeline;
                const currentPeriod = timeline.find(
                    p => p.status === 'unpaid' || p.status === 'partially_paid' || p.status === 'overdue'
                );

                if (!currentPeriod) continue;

                const periodEnd = new Date(currentPeriod.periodEnd);
                const diffTime = periodEnd.getTime() - currentDate.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                const dateStamp = currentDate.toISOString().slice(0, 10); // YYYY-MM-DD

                let nudgeType = null;
                if (diffDays === 5) nudgeType = 'due_in_5';
                else if (diffDays === 3) nudgeType = 'due_in_3';
                else if (diffDays === 2) nudgeType = 'due_in_2';
                else if (diffDays === 1) nudgeType = 'due_in_1';
                else if (diffDays === 0) nudgeType = 'due_today';
                else if (diffDays < 0) nudgeType = `overdue_${dateStamp}`;

                if (!nudgeType) continue;

                try {
                    const [borrowerUser, lenderUser] = await Promise.all([
                        loan.borrower
                            ? User.findOne({ id: loan.borrower })
                            : User.findOne({ phone: loan.borrowerPhone }),
                        loan.lender ? User.findOne({ id: loan.lender }) : null
                    ]);

                    const amountRupees = ((currentPeriod.expectedAmountPaise || 0) / 100).toLocaleString('en-IN');
                    const lenderName = lenderUser
                        ? `${lenderUser.firstName || ''} ${lenderUser.lastName || ''}`.trim() || 'your lender'
                        : 'your lender';
                    const borrowerName = loan.borrowerName ||
                        (borrowerUser ? `${borrowerUser.firstName || ''} ${borrowerUser.lastName || ''}`.trim() : 'the borrower');

                    // 1. Notify Borrower (Upcoming due reminder OR Overdue reminder)
                    if (borrowerUser && borrowerUser._id) {
                        const borrowerEventId = `PAYMENT_NUDGE-BORROWER-${loan._id}-p${currentPeriod.periodIndex}-${nudgeType}`;
                        const title = diffDays > 0
                            ? 'Upcoming Credit Payment Reminder'
                            : diffDays === 0
                                ? 'Credit Payment Due Today'
                                : 'Overdue Credit Payment Alert';
                        const body = diffDays > 0
                            ? `Your payment of ₹${amountRupees} for Period ${currentPeriod.periodIndex} to ${lenderName} is due in ${diffDays} ${diffDays === 1 ? 'day' : 'days'}.`
                            : diffDays === 0
                                ? `Your payment of ₹${amountRupees} for Period ${currentPeriod.periodIndex} to ${lenderName} is due today. Once paid, ask ${lenderName} to record it in HandCredit.`
                                : `Period ${currentPeriod.periodIndex} payment of ₹${amountRupees} to ${lenderName} is overdue (marked ✗). Please settle and ask ${lenderName} to record the payment.`;

                        await EventDispatcher.dispatch({
                            eventType: 'PAYMENT_NUDGE',
                            aggregateType: 'LOAN',
                            aggregateId: loan._id.toString(),
                            idempotencyKey: borrowerEventId,
                            recipientUserId: borrowerUser._id,
                            payload: {
                                title,
                                body,
                                type: 'LOAN_REMINDER',
                                loanId: loan._id.toString(),
                                periodIndex: String(currentPeriod.periodIndex),
                                amountPaise: String(currentPeriod.expectedAmountPaise),
                                deepLink: `khaata://loans/${loan._id}`
                            }
                        });
                        reminderCount++;
                    }

                    // 2. Notify Lender (Remind Lender to collect or tap 'Record Payment' if borrower already paid)
                    if (lenderUser && lenderUser._id && (diffDays <= 1)) {
                        const lenderEventId = `PAYMENT_NUDGE-LENDER-${loan._id}-p${currentPeriod.periodIndex}-${nudgeType}`;
                        const lenderTitle = diffDays >= 0
                            ? 'Credit Collection Due Soon'
                            : 'Overdue Credit — Record Payment if Received';
                        const lenderBody = diffDays >= 0
                            ? `${borrowerName}'s payment of ₹${amountRupees} (Period ${currentPeriod.periodIndex}) is due ${diffDays === 0 ? 'today' : 'tomorrow'}. Tap "Record Payment" once you receive it.`
                            : `${borrowerName}'s Period ${currentPeriod.periodIndex} payment of ₹${amountRupees} is past due (marked ✗). If they already paid you offline, please tap "Record Payment" in HandCredit.`;

                        await EventDispatcher.dispatch({
                            eventType: 'PAYMENT_NUDGE',
                            aggregateType: 'LOAN',
                            aggregateId: loan._id.toString(),
                            idempotencyKey: lenderEventId,
                            recipientUserId: lenderUser._id,
                            payload: {
                                title: lenderTitle,
                                body: lenderBody,
                                type: 'LOAN_REMINDER',
                                loanId: loan._id.toString(),
                                periodIndex: String(currentPeriod.periodIndex),
                                amountPaise: String(currentPeriod.expectedAmountPaise),
                                deepLink: `khaata://loans/${loan._id}`
                            }
                        });
                        reminderCount++;
                    }

                    if (diffDays <= 3 && diffDays > 0 && loan.status !== 'due_soon') {
                        loan.status = 'due_soon';
                        await loan.save();
                    } else if (diffDays <= 0 && loan.status !== 'overdue') {
                        loan.status = 'overdue';
                        await loan.save();
                    }
                } catch (e) {
                    logger.error(`[PaymentReminderWorker] Failed to process reminder for loan ${loan._id}: ${e.message}`);
                }
            }

            logger.info(`[PaymentReminderWorker] Completed daily reminder run. Dispatched ${reminderCount} reminders.`);
            return { success: true, remindersSent: reminderCount };
        } catch (e) {
            logger.error(`[PaymentReminderWorker] Fatal error: ${e.message}`);
            throw e;
        }
    }
}

module.exports = PaymentReminderWorker;
