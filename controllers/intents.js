const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const TransactionIntent = require('../models/TransactionIntent');
const OtpChallenge = require('../models/OtpChallenge');
const Loan = require('../models/Loan');
const EventDispatcher = require('../utils/EventDispatcher');

exports.createIntent = async (req, res) => {
    try {
        const { loanId, action, amountPaise, metadata } = req.body;
        
        // 1. Fetch Loan
        const loan = await Loan.findById(loanId);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        // 2. Resource Authorization
        if (action === 'ACCEPT_LOAN') {
            if (loan.borrower.toString() !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Only the borrower can accept this loan' });
            }
        } else {
            // Lender actions (PAYMENT, ADD_CREDIT, CLOSE_LOAN)
            if (loan.lender.toString() !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Only the lender can perform this action' });
            }
        }
        
        // 3. Loan State & FinancialStatus validation
        if (action === 'ACCEPT_LOAN' && loan.status !== 'pending_approval') {
            return res.status(409).json({
                success: false,
                code: 'LOAN_NOT_PENDING_APPROVAL',
                message: 'This loan is no longer awaiting borrower acceptance.'
            });
        }
        if (loan.status === 'frozen') {
            return res.status(400).json({ success: false, code: 'MUTATION_REJECTED', message: 'Loan is frozen' });
        }
        if (['closed', 'completed', 'rejected', 'cancelled', 'expired'].includes(loan.status) && action !== 'REVERSE') {
            return res.status(400).json({ success: false, code: 'MUTATION_REJECTED', message: 'Loan is in terminal state' });
        }
        
        // 4. Create Intent
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins expiry
        
        const intent = await TransactionIntent.create({
            intentId: crypto.randomUUID(),
            loanId,
            userId: req.user.id,
            action,
            payload: {
                amountPaise: amountPaise || 0,
                metadata: metadata || {}
            },
            status: 'PENDING',
            expiresAt
        });

        // 5. PAYMENT-specific: Generate OTP challenge and notify borrower
        if (action === 'PAYMENT') {
            // Generate cryptographically secure 6-digit OTP
            const otpPlaintext = crypto.randomInt(100000, 999999).toString();
            const otpHash = await bcrypt.hash(otpPlaintext, 10);

            // Invalidate any existing active challenges for this intent
            await OtpChallenge.updateMany(
                { intentId: intent.intentId, status: 'ACTIVE' },
                { status: 'EXPIRED' }
            );

            // Create new challenge
            await OtpChallenge.create({
                intentId: intent.intentId,
                otpHash,
                borrowerUserId: loan.borrower.toString(),
                lenderUserId: req.user.id,
                loanId,
                amountPaise: amountPaise || 0,
                attemptsRemaining: 5,
                status: 'ACTIVE'
            });

            // Send OTP to borrower via SILENT push notification
            try {
                const User = require('../models/User');
                const DeviceToken = require('../models/DeviceToken');
                const borrower = await User.findOne({ id: loan.borrower.toString() });
                if (borrower) {
                    const devices = await DeviceToken.find({ userId: borrower._id, active: true });
                    const tokenList = devices.map(d => d.token).filter(Boolean);
                    if (borrower.fcmToken && !tokenList.includes(borrower.fcmToken)) {
                        tokenList.push(borrower.fcmToken);
                    }
                    if (tokenList.length > 0) {
                        const admin = require('firebase-admin');
                        const amountRupees = ((amountPaise || 0) / 100).toFixed(2);
                        for (const token of tokenList) {
                            try {
                                await admin.messaging().send({
                                    token,
                                    notification: {
                                        title: 'Repayment Authorization Required',
                                        body: `Enter OTP ${otpPlaintext} to authorize repayment of ₹${amountRupees}`
                                    },
                                    data: {
                                        type: 'PAYMENT_OTP',
                                        intentId: intent.intentId,
                                        loanId: loan._id.toString(),
                                        amountPaise: String(amountPaise || 0)
                                    },
                                    android: {
                                        priority: 'high',
                                        notification: { channelId: 'payment_auth' }
                                    }
                                });
                            } catch (fcmErr) {
                                console.error('[Intents] FCM send failed for token:', fcmErr.message);
                            }
                        }
                    }

                    // Also dispatch an in-app notification (WITHOUT the OTP)
                    const amountRupees = ((amountPaise || 0) / 100).toFixed(2);
                    await EventDispatcher.dispatch({
                        eventType: 'PAYMENT_RECEIVED',
                        aggregateType: 'LOAN',
                        aggregateId: loan._id.toString(),
                        recipientUserId: borrower._id,
                        payload: {
                            title: 'Repayment Verification Requested',
                            body: `A repayment of ₹${amountRupees} is awaiting your OTP confirmation.`,
                            type: 'PAYMENT_AUTHORIZATION_REQUESTED',
                            loanId: loan._id.toString(),
                            intentId: intent.intentId
                        },
                        idempotencyKey: `${intent.intentId}_AUTH_REQ`
                    });
                }
            } catch (notifErr) {
                console.error('[Intents] Failed to send OTP notification:', notifErr);
            }
        } else if (action === 'ADD_CREDIT' || action === 'CLOSE_LOAN') {
            try {
                const User = require('../models/User');
                const borrower = await User.findOne({ id: loan.borrower.toString() });
                if (borrower && borrower._id) {
                    const amountRupees = ((amountPaise || 0) / 100).toFixed(2);
                    const isAdd = action === 'ADD_CREDIT';
                    await EventDispatcher.dispatch({
                        eventType: isAdd ? 'AGREEMENT_READY' : 'LOAN_CLOSED',
                        aggregateType: 'LOAN',
                        aggregateId: loan._id.toString(),
                        recipientUserId: borrower._id,
                        payload: {
                            title: isAdd ? 'Additional Credit Approval Needed' : 'Credit Closure Approval Needed',
                            body: isAdd
                                ? `Your counterparty requested to add ₹${amountRupees} to your credit record. Tap to review and approve.`
                                : 'Your counterparty requested to close this credit record. Tap to review.',
                            type: isAdd ? 'ADD_CREDIT_INTENT' : 'CLOSE_INTENT',
                            intentId: intent.intentId,
                            loanId: loan._id.toString(),
                            amountPaise: String(amountPaise || 0)
                        },
                        idempotencyKey: `${intent.intentId}_${action}`
                    });
                }
            } catch (dispatchErr) {
                console.error('[Intents] EventDispatcher failed:', dispatchErr);
            }
        }
        
        res.status(201).json({ success: true, intentId: intent.intentId, expiresAt: intent.expiresAt });
    } catch (err) {
        console.error('[Intents] createIntent Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};


exports.getIntent = async (req, res) => {
    try {
        const { intentId } = req.params;
        const intent = await TransactionIntent.findOne({ intentId });
        
        if (!intent) {
            return res.status(404).json({ success: false, code: 'UNKNOWN_INTENT', message: 'Intent not found' });
        }
        
        // Authorization: ensure user is either lender or borrower of the loan
        const loan = await Loan.findById(intent.loanId);
        if (loan) {
            if (loan.lender.toString() !== req.user.id && loan.borrower.toString() !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Unauthorized to view this intent' });
            }
        }
        
        // Return intent state
        res.status(200).json({ success: true, intent });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getIntentStatus = async (req, res) => {
    try {
        const { intentId } = req.params;
        const intent = await TransactionIntent.findOne({ intentId }).lean();
        if (!intent) {
            return res.status(404).json({ success: false, code: 'UNKNOWN_INTENT', message: 'Intent not found' });
        }
        res.status(200).json({ success: true, status: intent.status, intent });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.rejectIntent = async (req, res) => {
    try {
        const { intentId } = req.params;
        const intent = await TransactionIntent.findOne({ intentId });
        if (!intent) {
            return res.status(404).json({ success: false, code: 'UNKNOWN_INTENT', message: 'Intent not found' });
        }

        const loan = await Loan.findById(intent.loanId);
        if (loan) {
            if (loan.lender.toString() !== req.user.id && loan.borrower.toString() !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Unauthorized to reject this intent' });
            }
        }

        if (intent.status === 'PENDING') {
            intent.status = 'REJECTED';
            await intent.save();
            await OtpChallenge.updateMany({ intentId, status: 'ACTIVE' }, { status: 'EXPIRED' });

            // Notify the creator of the intent (typically the lender)
            try {
                const User = require('../models/User');
                const creator = await User.findOne({ id: intent.userId }).select('_id id');
                if (creator && creator._id && loan) {
                    await EventDispatcher.dispatch({
                        eventType: 'PAYMENT_FAILED',
                        aggregateType: 'LOAN',
                        aggregateId: loan._id.toString(),
                        recipientUserId: creator._id,
                        payload: {
                            title: 'Request Declined',
                            body: `Your counterparty declined the ${intent.action.replace('_', ' ').toLowerCase()} request.`,
                            type: 'INTENT_REJECTED',
                            loanId: loan._id.toString(),
                            intentId: intent.intentId
                        },
                        idempotencyKey: `${intent.intentId}_REJECTED`
                    });
                }
            } catch (notifErr) {
                console.error('[Intents] rejectIntent notification error:', notifErr.message);
            }
        }

        res.status(200).json({ success: true, status: intent.status });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

