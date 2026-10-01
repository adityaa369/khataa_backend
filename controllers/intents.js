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
            // IMPORTANT: This is NOT an in-app notification. The OTP is sent
            // as a data-only push that the client displays as a system notification.
            // It must NEVER be stored in NotificationOutbox (no in-app history).
            try {
                const User = require('../models/User');
                const borrower = await User.findById(loan.borrower.toString());
                if (borrower && borrower.fcmTokens && borrower.fcmTokens.length > 0) {
                    const admin = require('firebase-admin');
                    const amountRupees = ((amountPaise || 0) / 100).toFixed(2);
                    
                    // Send to all registered devices
                    for (const tokenObj of borrower.fcmTokens) {
                        const token = typeof tokenObj === 'string' ? tokenObj : tokenObj.token;
                        if (!token) continue;
                        try {
                            await admin.messaging().send({
                                token,
                                notification: {
                                    title: 'Payment Authorization Required',
                                    body: `Enter OTP ${otpPlaintext} to authorize payment of ₹${amountRupees}`
                                },
                                data: {
                                    type: 'PAYMENT_OTP',
                                    intentId: intent.intentId,
                                    loanId,
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
            } catch (notifErr) {
                console.error('[Intents] Failed to send OTP notification:', notifErr);
                // Non-blocking — borrower can request resend
            }

            // Also dispatch an in-app notification (WITHOUT the OTP)
            try {
                await EventDispatcher.dispatch({
                    eventType: 'PAYMENT_AUTHORIZATION_REQUESTED',
                    recipientUserId: loan.borrower.toString(),
                    data: { amountPaise: amountPaise || 0, lenderId: req.user.id },
                    loanId
                });
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

