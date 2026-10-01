const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const TransactionIntent = require('../models/TransactionIntent');
const OtpChallenge = require('../models/OtpChallenge');
const Loan = require('../models/Loan');
const FinancialLedgerService = require('../services/FinancialLedgerService');
const EventDispatcher = require('../utils/EventDispatcher');
const admin = require('firebase-admin');

exports.initiatePayment = async (req, res) => {
    try {
        const { id: loanId } = req.params;
        const { amountPaise, note } = req.body;

        if (!amountPaise || amountPaise <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amountPaise is required' });
        }

        const loan = await Loan.findById(loanId);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        if (loan.lender.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only lender can initiate payment' });
        }

        if (['closed', 'completed', 'rejected', 'cancelled', 'expired'].includes(loan.status)) {
            return res.status(400).json({ success: false, code: 'TERMINAL_STATE', message: 'Loan is in terminal state' });
        }

        const balances = FinancialLedgerService.deriveBalances(loan);
        const totalOutstandingPaise = balances.totalOutstandingPaise || 0;
        if (amountPaise > totalOutstandingPaise) {
            return res.status(400).json({
                success: false,
                code: 'OVERPAYMENT_REJECTED',
                message: \Payment of ?\ exceeds outstanding balance of ?\\
            });
        }

        const intentId = \intent_\\;
        
        await TransactionIntent.create({
            intentId,
            action: 'PAYMENT',
            userId: req.user.id,
            loanId: loan._id,
            status: 'PENDING',
            payload: { amountPaise, note },
            expiresAt: new Date(Date.now() + 5 * 60000)
        });

        const rawOtp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpHash = await bcrypt.hash(rawOtp, 10);

        await OtpChallenge.create({
            intentId,
            otpHash,
            borrowerUserId: loan.borrower.toString(),
            lenderUserId: loan.lender.toString(),
            loanId: loan._id.toString(),
            amountPaise,
            attemptsRemaining: 5,
            status: 'ACTIVE'
        });

        try {
            await EventDispatcher.dispatch({
                eventType: 'PAYMENT_OTP',
                recipientUserId: loan.borrower.toString(),
                data: { amountPaise, intentId },
                payload: {
                    title: 'Payment Authorization',
                    body: \OTP to authorize payment of ?\ is \\,
                    type: 'PAYMENT_OTP',
                    loanId: loan._id.toString()
                },
                loanId: loan._id.toString()
            });
        } catch (e) {
            console.error('[InitiatePayment] Notification failed:', e.message);
        }

        res.status(201).json({
            success: true,
            intentId,
            message: 'Payment intent created. OTP sent to borrower.'
        });
    } catch (err) {
        console.error('[InitiatePayment] Error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * POST /loans/:id/commit-payment
 * 
 * Two-stage payment authorization:
 * 1. Lender creates PAYMENT intent (via POST /intents)
 * 2. Server generates OTP, sends to borrower via push
 * 3. Borrower enters OTP on this endpoint
 * 4. On valid OTP → calls FROZEN FinancialLedgerService.recordPayment
 * 
 * Request body: { intentId, otp, idToken }
 * 
 * This endpoint does NOT modify the financial ledger logic.
 * It only wraps the existing recordPayment with OTP validation.
 */
exports.commitPayment = async (req, res) => {
    try {
        const { id: loanId } = req.params;
        const { intentId, otp, idToken } = req.body;

        // 1. Validate inputs
        if (!intentId || !otp) {
            return res.status(400).json({
                success: false,
                code: 'VALIDATION_ERROR',
                message: 'intentId and otp are required'
            });
        }

        // 2. Verify Firebase idToken
        try {
            await admin.auth().verifyIdToken(idToken);
        } catch (e) {
            return res.status(400).json({ success: false, message: 'Invalid idToken' });
        }

        // 3. Fetch and validate intent
        const intent = await TransactionIntent.findOne({ intentId, loanId });
        if (!intent) {
            return res.status(404).json({
                success: false,
                code: 'UNKNOWN_INTENT',
                message: 'Payment intent not found'
            });
        }

        if (intent.action !== 'PAYMENT') {
            return res.status(400).json({
                success: false,
                code: 'INVALID_INTENT_TYPE',
                message: 'Intent is not a payment intent'
            });
        }

        if (intent.status !== 'PENDING') {
            return res.status(409).json({
                success: false,
                code: 'INTENT_CONSUMED',
                message: 'This payment intent has already been processed'
            });
        }

        if (intent.expiresAt && new Date() > intent.expiresAt) {
            await TransactionIntent.updateOne({ intentId }, { status: 'REJECTED' });
            return res.status(410).json({
                success: false,
                code: 'INTENT_EXPIRED',
                message: 'Payment intent has expired'
            });
        }

        // 4. Fetch loan and authorize
        const loan = await Loan.findById(loanId);
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        // Borrower must be the one submitting the OTP
        if (loan.borrower.toString() !== req.user.id) {
            return res.status(403).json({
                success: false,
                code: 'UNAUTHORIZED_ACTION',
                message: 'Only the borrower can authorize this payment'
            });
        }

        // Loan state checks
        if (loan.status === 'frozen') {
            return res.status(400).json({ success: false, code: 'LOAN_FROZEN', message: 'Loan is frozen' });
        }
        if (['closed', 'completed', 'rejected', 'cancelled', 'expired'].includes(loan.status)) {
            return res.status(400).json({ success: false, code: 'TERMINAL_STATE', message: 'Loan is in terminal state' });
        }

        // 5. Validate OTP challenge
        const challenge = await OtpChallenge.findOne({
            intentId,
            status: 'ACTIVE'
        });

        if (!challenge) {
            return res.status(404).json({
                success: false,
                code: 'OTP_EXPIRED',
                message: 'OTP has expired or was not generated. Please request a new payment.'
            });
        }

        if (challenge.attemptsRemaining <= 0) {
            await OtpChallenge.updateOne({ _id: challenge._id }, { status: 'LOCKED' });
            await TransactionIntent.updateOne({ intentId }, { status: 'REJECTED' });
            return res.status(429).json({
                success: false,
                code: 'OTP_LOCKED',
                message: 'Too many incorrect attempts. Payment has been cancelled.'
            });
        }

        // Verify OTP against bcrypt hash
        const isValid = await bcrypt.compare(otp, challenge.otpHash);
        if (!isValid) {
            await OtpChallenge.updateOne(
                { _id: challenge._id },
                { $inc: { attemptsRemaining: -1 } }
            );
            const remaining = challenge.attemptsRemaining - 1;
            return res.status(401).json({
                success: false,
                code: 'OTP_INVALID',
                message: `Invalid OTP. ${remaining} attempt(s) remaining.`,
                attemptsRemaining: remaining
            });
        }

        // 6. OTP valid — consume challenge and intent
        await OtpChallenge.updateOne({ _id: challenge._id }, { status: 'CONSUMED' });

        // 7. Overpayment check (same as existing recordPayment)
        const amountPaise = intent.payload.amountPaise;
        const balances = FinancialLedgerService.deriveBalances(loan);
        const totalOutstandingPaise = balances.totalOutstandingPaise || 0;

        if (amountPaise > totalOutstandingPaise) {
            await TransactionIntent.updateOne({ intentId }, { status: 'REJECTED' });
            return res.status(400).json({
                success: false,
                code: 'OVERPAYMENT_REJECTED',
                message: `Payment of ₹${(amountPaise / 100).toFixed(2)} exceeds outstanding balance of ₹${(totalOutstandingPaise / 100).toFixed(2)}`
            });
        }

        // 8. Execute payment via FROZEN FinancialLedgerService
        const result = await FinancialLedgerService.recordPayment(loan, amountPaise, {
            type: 'PAYMENT',
            initiatedBy: intent.userId, // lender who initiated
            authorizedBy: req.user.id,  // borrower who authorized
            intentId: intentId
        });

        // 9. Mark intent as committed
        await TransactionIntent.updateOne({ intentId }, { status: 'COMMITTED' });

        // 10. Dispatch notifications
        try {
            // Notify lender: payment was authorized and recorded
            await EventDispatcher.dispatch({
                eventType: 'PAYMENT_RECEIVED',
                recipientUserId: intent.userId, // lender
                data: { amountPaise, borrowerId: req.user.id },
                loanId
            });

            // Notify borrower: payment confirmed
            await EventDispatcher.dispatch({
                eventType: 'PAYMENT_MADE',
                recipientUserId: req.user.id, // borrower
                data: { amountPaise },
                loanId
            });
        } catch (notifErr) {
            console.error('[CommitPayment] Notification dispatch failed:', notifErr);
            // Non-blocking — payment already recorded
        }

        // 11. Return updated loan
        const updatedLoan = await Loan.findById(loanId);
        res.status(200).json({
            success: true,
            loan: updatedLoan,
            allocations: result.allocations
        });

    } catch (err) {
        console.error('[CommitPayment] Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};

