const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const TransactionIntent = require('../models/TransactionIntent');
const OtpChallenge = require('../models/OtpChallenge');
const Loan = require('../models/Loan');
const User = require('../models/User');
const FinancialLedgerService = require('../services/FinancialLedgerService');
const mongoose = require('mongoose');
const EventDispatcher = require('../utils/EventDispatcher');
const EncryptionUtil = require('../utils/encryption');
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

        FinancialLedgerService.deriveBalances(loan);
        const totalOutstandingPaise = (loan.principalOutstandingPaise != null ? loan.principalOutstandingPaise : (loan.totalPayablePaise - (loan.paidAmountPaise || 0))) || 0;
        if (amountPaise > totalOutstandingPaise) {
            return res.status(400).json({
                success: false,
                code: 'OVERPAYMENT_REJECTED',
                message: `Payment of ₹${(amountPaise/100).toFixed(2)} exceeds outstanding balance of ₹${(totalOutstandingPaise/100).toFixed(2)}`
            });
        }

        const intentId = `intent_${crypto.randomUUID()}`;
        
        await TransactionIntent.create({
            intentId,
            action: 'PAYMENT',
            userId: req.user.id,
            loanId: loan._id,
            status: 'PENDING',
            payload: { amountPaise, note },
            expiresAt: new Date(Date.now() + 5 * 60000)
        });

        // 1. Borrower Phone Lookup (Authoritative)
        const borrower = await User.findOne({ id: loan.borrower });
        if (!borrower || !borrower.phone) {
            return res.status(400).json({ success: false, message: 'Borrower phone number not found' });
        }

        // 2. Cryptographically Secure OTP Generation
        const rawOtp = crypto.randomInt(100000, 999999).toString();
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

        // 3. Dispatch to SMS Outbox exclusively (Bypasses ordinary preferences)
        // We use symmetric encryption so the worker can securely read the OTP.
        try {
            const encryptedOtp = EncryptionUtil.encrypt(rawOtp);
            await EventDispatcher.dispatch({
                eventType: 'PAYMENT_OTP_SMS',
                aggregateType: 'PAYMENT_INTENT',
                aggregateId: intentId,
                recipientUserId: loan.borrower.toString(),
                channels: ['SMS'],
                payload: {
                    phone: borrower.phone,
                    encryptedOtp: encryptedOtp,
                    amountPaise: amountPaise,
                    loanId: loan._id.toString(),
                    intentId: intentId
                },
                idempotencyKey: intentId
            });
        } catch (e) {
            console.error('[InitiatePayment] SMS Dispatch failed:', e.message);
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

        // The lender initiates and records the payment, providing the OTP obtained from the borrower
        if (loan.lender.toString() !== req.user.id) {
            return res.status(403).json({
                success: false,
                code: 'UNAUTHORIZED_ACTION',
                message: 'Only the lender can record this payment'
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
            return res.status(400).json({
                success: false,
                code: 'OTP_INVALID',
                message: `Invalid OTP. ${remaining} attempt(s) remaining.`,
                attemptsRemaining: remaining
            });
        }

        // 6. Overpayment check before transaction
        const amountPaise = intent.payload.amountPaise;
        FinancialLedgerService.deriveBalances(loan);
        const totalOutstandingPaise = (loan.principalOutstandingPaise != null ? loan.principalOutstandingPaise : (loan.totalPayablePaise - (loan.paidAmountPaise || 0))) || 0;

        if (amountPaise > totalOutstandingPaise) {
            await TransactionIntent.updateOne({ intentId }, { status: 'REJECTED' });
            return res.status(400).json({
                success: false,
                code: 'OVERPAYMENT_REJECTED',
                message: `Payment of ₹${(amountPaise / 100).toFixed(2)} exceeds outstanding balance of ₹${(totalOutstandingPaise / 100).toFixed(2)}`
            });
        }

        // 7. Atomic Execution
        const session = await mongoose.startSession();
        session.startTransaction();
        let result;
        try {
            // Consume challenge
            await OtpChallenge.updateOne({ _id: challenge._id }, { status: 'CONSUMED' }, { session });

            // Execute payment via FROZEN FinancialLedgerService
            result = await FinancialLedgerService.recordPayment(loan, amountPaise, intentId, req.user.id);
            
            // Fix: Actually save the loan inside the transaction!
            await loan.save({ session });

            // Mark intent as committed
            await TransactionIntent.updateOne({ intentId }, { status: 'COMMITTED' }, { session });

            await session.commitTransaction();
        } catch (err) {
            await session.abortTransaction();
            console.error('[CommitPayment] Transaction aborted:', err);
            return res.status(500).json({ success: false, message: 'Payment execution failed', error: err.message });
        } finally {
            session.endSession();
        }

        // 8. Dispatch notifications (outside transaction)
        try {
            await EventDispatcher.dispatch({
                eventType: 'PAYMENT_RECEIVED',
                recipientUserId: intent.userId, // lender
                data: { amountPaise, borrowerId: req.user.id },
                loanId
            });
            await EventDispatcher.dispatch({
                eventType: 'PAYMENT_MADE',
                recipientUserId: req.user.id, // borrower
                data: { amountPaise },
                loanId
            });
        } catch (notifErr) {
            console.error('[CommitPayment] Notification dispatch failed:', notifErr);
        }

        // 11. Return updated loan
        const updatedLoan = await Loan.findById(loanId);
        res.status(200).json({
            success: true,
            loan: updatedLoan
        });

    } catch (err) {
        console.error('[CommitPayment] Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};


// @desc    Resend OTP for Payment Intent
// @route   POST /api/loans/:id/payments/intents/:intentId/resend
// @access  Private (Lender)
exports.resendPaymentOtp = async (req, res) => {
    try {
        const { id: loanId, intentId } = req.params;

        const loan = await Loan.findById(loanId);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        if (loan.lender.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only lender can resend payment OTP' });
        }

        const intent = await TransactionIntent.findOne({ intentId, loanId: loan._id });
        if (!intent) return res.status(404).json({ success: false, message: 'Payment intent not found' });

        if (intent.status !== 'PENDING' || intent.expiresAt < new Date()) {
            return res.status(400).json({ success: false, message: 'Payment intent is not active' });
        }

        // Rate limiting check (e.g. cooldown of 60 seconds)
        const recentChallenge = await OtpChallenge.findOne({ intentId }).sort({ createdAt: -1 });
        if (recentChallenge && (Date.now() - recentChallenge.createdAt.getTime() < 60000)) {
            return res.status(429).json({ success: false, message: 'Please wait 60 seconds before resending OTP' });
        }

        // Invalidate old challenges
        await OtpChallenge.updateMany(
            { intentId, status: 'ACTIVE' },
            { $set: { status: 'EXPIRED' } }
        );

        // 1. Borrower Phone Lookup (Authoritative)
        const borrower = await User.findOne({ id: loan.borrower });
        if (!borrower || !borrower.phone) {
            return res.status(400).json({ success: false, message: 'Borrower phone number not found' });
        }

        // 2. Cryptographically Secure OTP Generation
        const rawOtp = crypto.randomInt(100000, 999999).toString();
        const otpHash = await bcrypt.hash(rawOtp, 10);

        await OtpChallenge.create({
            intentId,
            otpHash,
            borrowerUserId: loan.borrower.toString(),
            lenderUserId: loan.lender.toString(),
            loanId: loan._id.toString(),
            amountPaise: intent.payload.amountPaise,
            attemptsRemaining: 5,
            status: 'ACTIVE'
        });

        // 3. Dispatch to SMS Outbox exclusively
        try {
            const encryptedOtp = EncryptionUtil.encrypt(rawOtp);
            await EventDispatcher.dispatch({
                eventType: 'PAYMENT_OTP_SMS_RESEND',
                aggregateType: 'PAYMENT_INTENT',
                aggregateId: intentId,
                recipientUserId: loan.borrower.toString(),
                channels: ['SMS'],
                payload: {
                    phone: borrower.phone,
                    encryptedOtp: encryptedOtp,
                    amountPaise: intent.payload.amountPaise,
                    loanId: loan._id.toString(),
                    intentId: intentId
                },
                idempotencyKey: intentId + '_' + Date.now()
            });
        } catch (e) {
            console.error('[ResendOTP] SMS Dispatch failed:', e.message);
        }

        res.status(200).json({
            success: true,
            message: 'A new OTP has been sent to the borrower.'
        });
    } catch (err) {
        console.error('[ResendOTP] Error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
