const Notification = require('../models/Notification');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const Loan = require('../models/Loan');
const { serializeLoan } = require('../utils/loanSerializer');
const User = require('../models/User');
const { sendOtp } = require('../utils/otpProvider');
const { updateCreditScore } = require('../utils/creditScoreCalc');
const { sendEmail } = require('../utils/email');
const { loanGivenTemplate, paymentRecordedTemplate, loanClosedTemplate } = require('../utils/emailTemplates');
const axios = require('axios');
const { invalidateLoanCache } = require('../middleware/cache');
const { trackFinancialEvent, triggerAlert } = require('../utils/telemetry');
const { metrics } = require('../middleware/metrics');
const { withTransaction } = require('../utils/dbTransaction');
const { cacheGet, cacheSet, cacheInvalidate } = require('../config/redis');



function sendError(res, err, status = 500) {
    const isProd = process.env.NODE_ENV === 'production';
    return res.status(status).json({
        success: false,
        message: isProd && status === 500 ? 'An internal error occurred' : err.message
    });
}

// Helper to verify Firebase OTP via Identity Toolkit API
module.exports._verifyFirebaseIdToken = async function(idToken) {
    return verifyFirebaseIdToken(idToken);
};

async function verifyFirebaseIdToken(idToken) {
    if (!idToken) return { success: false, message: 'Missing idToken' };
    try {
        const admin = require('firebase-admin');
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        if (!decodedToken.phone_number) return { success: false, message: 'No phone number in token' };
        return { success: true, phone: decodedToken.phone_number };
    } catch (err) {
        console.error('[Firebase] Verify Token Error:', err.message);
        return { success: false, message: 'Invalid idToken' };
    }
}

// @desc    Create a new loan
// @route   POST /api/loans
// @access  Private (Lender)

const fetchV2TransactionsAsLegacy = async (loanId) => {
    const Transaction = require('../models/Transaction');
    const txs = await Transaction.find({ loanId }).sort({ sequenceNumber: 1, effectiveAt: 1 });
    return txs.map(tx => ({
        type: tx.type.toLowerCase(),
        amountPaise: tx.amountPaise,
        note: tx.type === 'LOAN_CREATED' ? 'Loan Issued'
            : tx.type === 'INTEREST_ACCRUED' ? 'Interest Accrued'
            : tx.type === 'CREDIT_ADDED' ? 'Credit Added'
            : tx.type === 'WRITE_OFF' ? 'Write Off'
            : tx.type === 'REVERSAL' ? 'Reversal'
            : 'Payment Recorded',
        recordedAt: tx.effectiveAt,
        recordedBy: tx.actorId
    }));
};

exports.createLoan = async (req, res) => {
    try {
        let {
            borrower_phone,
            borrower_name,
            borrower_aadhar,
            borrower_address,
            amountPaise,
            interest_rate,
            duration_months,
            duration_type,
            type,
            transaction_id,
            documentId
        } = req.body;

        // Sanitize phone: strip 91 or +91
        const amount = amountPaise ? amountPaise / 100 : 0;
        const borrowerPhone = borrower_phone.toString().replace(/^\+?91/, '');
        const borrowerName = borrower_name;
        const borrowerAadhar = borrower_aadhar;
        const borrowerAddress = borrower_address;
        const interestRate = interest_rate;
        const durationMonths = duration_months;
        const durationType = duration_type || 'Months';
        const loanType = type || 'personal';

        if (borrowerPhone === req.user.phone) {
            return res.status(400).json({
                success: false,
                message: 'You cannot give a loan to yourself'
            });
        }

        if (transaction_id) {
            const existingLoan = await Loan.findOne({ transaction_id, lender: req.user.id });
            if (existingLoan) {
                console.warn(`[Loans] Idempotency intercepted for transaction ${transaction_id}`);
                return res.status(200).json({
                    success: true,
                    message: 'Loan already created',
                    loan: serializeLoan(existingLoan)
                });
            }
        }

        // Check if borrower exists in system (STRICT CHECK)
        let borrower = await User.findOne({ phone: borrowerPhone });
        if (!borrower) {
            console.error(`[Loans] Borrower ${borrowerPhone} not found in system.`);
            return res.status(404).json({
                success: false,
                message: 'Borrower not found. Please ask the user to register first.'
            });
        }

        if (!borrower.email) {
            console.error(`[Loans] Borrower ${borrowerPhone} does not have a registered email.`);
            return res.status(400).json({
                success: false,
                message: 'Borrower does not have a registered email address. Please ask them to update their profile first.'
            });
        }

        // Prevent Duplicate Loans via accidental multiple clicks (Issue Fix)
        const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000);
        const duplicateLoan = await Loan.findOne({
            lender: req.user.id,
            borrowerPhone: borrowerPhone,
            amount: amount,
            createdAt: { $gte: twoMinsAgo }
        });

        if (duplicateLoan) {
            console.warn(`[Loans] Duplicate loan creation attempt intercepted for ${borrowerPhone}`);
            return res.status(429).json({
                success: false,
                message: 'Duplicate loan request detected. Please wait a moment.'
            });
        }

        const monthsTracking = [];
        for (let i = 1; i <= durationMonths; i++) {
            monthsTracking.push({
                monthIndex: i,
                status: 'unpaid'
            });
        }

        const loan = await Loan.create({
            lender: req.user.id,
            borrower: borrower.id,
            borrowerName,
            borrowerPhone,
            borrowerAadhar,
            borrowerAddress,
            amount,
            amountPaise: require('../utils/money').parseRupeesToPaise(amount),
            interestRate,
            durationMonths,
            durationType,
            loanType,
            status: 'pending_approval',
            transaction_id,
            documentId,
            otp: 'FIREBASE_OTP',
            isOtpVerified: false,
            monthsTracking
        });
        
        const TransactionIntent = require('../models/TransactionIntent');
        const intent = await TransactionIntent.create({
            loanId: loan._id,
            userId: borrower.id, // borrower.id is the string ID
            action: 'ACCEPT_LOAN',
            payload: { amountPaise: require('../utils/money').parseRupeesToPaise(amount) },
            status: 'PENDING',
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
        });

        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        const lenderName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'A lender';

        // Send FCM alert telling borrower setup has been initiated
        if (borrower) {
            Notification.create({ userId: borrower._id, title: 'Lender Setup Verification', body: `A credit agreement setup for ₹${amount} has been initiated by ${lenderName}.`, data: { type: 'LOAN_INIT_OTP', loanId: loan._id.toString(), intentId: intent.intentId } }).catch(err => console.log('Notification DB Error', err));
            
            const NotificationOutbox = require('../models/NotificationOutbox');
            await NotificationOutbox.create({
                aggregateType: 'LOAN',
                aggregateId: loan._id.toString(),
                eventType: 'LOAN_INIT_OTP',
                recipientUserId: borrower._id,
                channel: 'PUSH',
                payload: {
                    title: 'Lender Setup Verification',
                    body: `A credit agreement setup for ₹${amount} has been initiated by ${lenderName}.`,
                    loanId: loan._id.toString(),
                    intentId: intent.intentId
                }
            });
        }

        
        res.status(201).json({
            success: true,
            message: 'Loan agreement initiated. OTP sent to borrower.',
            loan: serializeLoan(loan)
        });
    } catch (err) {
        console.error('[Loans] createLoan Error:', err.message);
        sendError(res, err);
    }
};

// @desc    Get loans given by current user
// @route   GET /api/loans/given
// @access  Private
exports.getGivenLoans = async (req, res) => {
    try {
        const cacheKey = `loans:given:${req.user.id}`;
        const cached = await cacheGet(cacheKey);
        if (cached) return res.status(200).json(cached);

        const loans = await Loan.find({ lender: req.user.id });
        const loansMapped = [];
        const User = require('../models/User'); // Import User model
        for (const loan of loans) {
            const loanObj = serializeLoan(loan);
            
            // Dynamically fetch borrower name if registered
            if (loanObj.borrower) {
                const borrowerUser = await User.findOne({ id: loanObj.borrower });
                if (borrowerUser) {
                    const realName = `${borrowerUser.firstName || ''} ${borrowerUser.lastName || ''}`.trim();
                    if (realName) {
                        loanObj.borrowerName = realName;
                    }
                }
            }
            
            loansMapped.push(loanObj);
        }
        
        // --- CHIT FUNDS AGGREGATION ---
        const ChitFund = require('../models/ChitFund');
        const ownedChits = await ChitFund.find({ owner: req.user.id });

        for (const chit of ownedChits) {
            loansMapped.push({
                _id: chit._id,
                loanType: 'chitfund',
                amount: chit.totalValue, amountPaise: Math.round(chit.totalValue * 100),
                interestRate: 0,
                durationMonths: chit.totalMonths,
                status: chit.status === 'completed' ? 'completed' : 'active',
                progress: (chit.completedMonths || 0) / (chit.totalMonths || 1),
                startDate: chit.startDate || chit.createdAt,
                endDate: null,
                lenderName: `${req.user.firstName || ''} ${req.user.lastName || ''}`,
                borrowerName: `${chit.currentSubscribersCount} Member(s)`,
                borrowerPhone: 'N/A',
                emiAmount: chit.monthlySubscription, emiAmountPaise: Math.round(chit.monthlySubscription * 100),
                createdAt: chit.createdAt
            });
        }
        
        loansMapped.sort((a, b) => {
            const aDate = new Date(a.createdAt || a.startDate || 0);
            const bDate = new Date(b.createdAt || b.startDate || 0);
            return bDate - aDate;
        });

        await cacheSet(cacheKey, { success: true, loans: loansMapped }, 120);
        res.status(200).json({ success: true, loans: loansMapped });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Get loans taken by current user
// @route   GET /api/loans/taken
// @access  Private
exports.getTakenLoans = async (req, res) => {
    try {
        const cacheKey = `loans:taken:${req.user.id}`;
        const cached = await cacheGet(cacheKey);
        if (cached) return res.status(200).json(cached);

        // Sanitize phone for query consistency
        const phone = req.user.phone.toString().replace(/^\+?91/, '');
        const loans = await Loan.find({
            $or: [
                { borrowerPhone: phone },
                { borrower: req.user.id }
            ],
            lender: { $ne: req.user.id } // Explicitly exclude loans where I am the lender
        });

        // Populate lender details manually to avoid changing the Mongoose schema
        const loansWithLender = [];
        for (const loan of loans) {
            const lenderUser = await User.findOne({ id: loan.lender });
            const loanObj = serializeLoan(loan);
            if (lenderUser) {
                loanObj.lenderName = `${lenderUser.firstName || ''} ${lenderUser.lastName || ''}`.trim() || 'Unknown Lender';
                loanObj.lenderPhone = lenderUser.phone || '';
            } else {
                loanObj.lenderName = 'Unknown Lender';
                loanObj.lenderPhone = '';
            }
            loansWithLender.push(loanObj);
        }

        // --- CHIT SUBSCRIPTIONS AGGREGATION ---
        const ChitSubscription = require('../models/ChitSubscription');
        const ChitFund = require('../models/ChitFund');

        const activeChits = await ChitSubscription.find({ user: req.user.id }).populate('chitFund');
        for (const sub of activeChits) {
            if (!sub.chitFund) continue;
            const chitFund = sub.chitFund;
            
            const groupOwner = await User.findOne({ id: chitFund.owner });
            const ownerName = groupOwner ? `${groupOwner.firstName || ''} ${groupOwner.lastName || ''}`.trim() : 'Unknown Network';

            loansWithLender.push({
                _id: sub._id,
                loanType: 'chitfund',
                amount: chitFund.totalValue,
                interestRate: 0,
                durationMonths: chitFund.totalMonths,
                status: sub.status === 'completed' ? 'completed' : 'active',
                progress: (sub.installmentsPaid || 0) / (chitFund.totalMonths || 1),
                startDate: chitFund.startDate || chitFund.createdAt,
                endDate: null,
                lenderName: ownerName,
                borrowerName: `${req.user.firstName || ''} ${req.user.lastName || ''}`,
                borrowerPhone: req.user.phone,
                emiAmount: chitFund.monthlySubscription,
                createdAt: sub.createdAt
            });
        }

        // Sort combined list by created date descending
        loansWithLender.sort((a, b) => {
            const aDate = new Date(a.createdAt || a.startDate || 0);
            const bDate = new Date(b.createdAt || b.startDate || 0);
            return bDate - aDate;
        });

        await cacheSet(cacheKey, { success: true, loans: loansWithLender }, 120);
        res.status(200).json({ success: true, loans: loansWithLender });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Verify/Approve loan agreement (Borrower Self-Verification)
// @route   POST /api/loans/:id/verify
// @access  Private (Borrower)
exports.verifyLoan = async (req, res) => {
    try {
        const { otp } = req.body;
        const loanId = req.params.id;
        
        // Hand off to FinancialLedgerService to initialize ledger balances & outbox
        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const { intentId } = req.body;
        if (!otp || !intentId) return res.status(400).json({ success: false, message: 'OTP and intentId are required' });
        const { verifyFirebaseIdToken } = require('../middleware/auth');
        const vResult = await module.exports._verifyFirebaseIdToken(otp);
        if (!vResult.success) return res.status(400).json({ success: false, message: 'Invalid OTP' });
        const Loan = require('../models/Loan');
        const currentLoan = await Loan.findById(loanId);
        if (vResult.phone.replace(/\D/g, '').slice(-10) !== currentLoan.borrowerPhone.replace(/\D/g, '').slice(-10)) return res.status(400).json({ success: false, message: 'OTP phone mismatch' });
        await FinancialLedgerService.acceptLoan(loanId, req.user.id, intentId);
        const loan = await Loan.findById(loanId);

        await invalidateLoanCache(loan.lender, loan.borrower);

        res.status(200).json({
            success: true,
            message: 'Loan accepted and activated successfully',
            loan
        });
    } catch (err) {
        console.error('[Loans] verifyLoan Error:', err.message);
        if (err.message.includes('UNAUTHORIZED_ACTION')) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        res.status(400).json({ success: false, message: err.message });
    }
};

// @desc    Resend loan agreement OTP
// @route   POST /api/loans/:id/resend-otp
// @access  Private
exports.resendLoanOtp = async (req, res) => {
    try {
        const loan = await Loan.findById(req.params.id);

        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        res.status(200).json({ success: true, message: 'Firebase SMS OTP verification should be handled client-side.' });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Request OTP for Closing Loan Agreement
// @route   POST /api/loans/:id/close-otp
// @access  Private (Lender)
exports.requestClosureOtp = async (req, res) => {
    try {
        const loan = await Loan.findById(req.params.id);

        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        if (loan.lender !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only lender can initiate closure.' });
        }

        if (loan.status === 'closed') {
            return res.status(400).json({ success: false, message: 'Loan is already closed' });
        }

        res.status(200).json({ success: true, message: 'Firebase SMS OTP verification should be handled client-side.' });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Update loan repayment progress
// @route   PATCH /api/loans/:id/progress
// @access  Private (Lender)
exports.updateProgress = async (req, res) => {
    try {
        const { progress } = req.body; // 0.0 to 1.0
        const loan = await Loan.findById(req.params.id);

        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        if (loan.lender !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only lender can update progress' });
        }

        loan.progress = progress;
        if (progress >= 1.0) {
            loan.status = 'completed';
        }
        await loan.save();
        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        // Update Credit Score of borrower
        if (loan.borrower) {
            await updateCreditScore(loan.borrower);
            
            // Send Push Notification so borrower UI refreshes automatically
            const User = require('../models/User');
            const borrowerUser = await User.findOne({ id: loan.borrower });
            if (borrowerUser) {
                const NotificationOutbox = require('../models/NotificationOutbox');
                await NotificationOutbox.create({
                    aggregateType: 'LOAN',
                    aggregateId: loan._id.toString(),
                    eventType: 'LOAN_PROGRESS_UPDATED',
                    recipientUserId: borrowerUser._id,
                    channel: 'PUSH',
                    payload: {
                        title: 'Loan Progress Updated',
                        body: `Your lender has updated the repayment progress for your loan of ₹${loan.amount}.`,
                        loanId: loan._id.toString()
                    }
                });
            }
        }

        res.status(200).json({ success: true, loan: serializeLoan(loan) });
    } catch (err) {
        sendError(res, err);
    }
};

// Credit score logic is extracted to shared utility

// @desc    Verify Lender OTP to confirm creation Intent
// @route   POST /api/loans/:id/verify-lender-otp
// @access  Private (Lender)
exports.verifyLenderOtp = async (req, res) => {
    try {
        const { idToken } = req.body;
        const loan = await Loan.findById(req.params.id);

        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        if (loan.lender !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only lender can confirm this action' });
        }

        if (loan.status !== 'pending_otp') {
            return res.status(400).json({ success: false, message: 'Loan is not in OTP pending state' });
        }

        const verificationResult = await module.exports._verifyFirebaseIdToken(idToken);
        if (!verificationResult.success) {
            return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid OTP' });
        }

        const returnedPhone = verificationResult.phone.replace(/\D/g, '').slice(-10);
        const User = require('../models/User');
        const lenderUser = await User.findById(req.user.id);
        const expectedPhone = lenderUser.phone.replace(/\D/g, '').slice(-10);
        if (returnedPhone !== expectedPhone) {
            return res.status(400).json({
                success: false,
                message: 'OTP verified phone does not match lender phone'
            });
        }

        loan.status = 'pending_approval';
        loan.isOtpVerified = true;
        await loan.save();
        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        // Now trigger the Push Notification to the borrower
        const borrowerUser = await User.findOne({ id: loan.borrower });
        if (borrowerUser) {
            const NotificationOutbox = require('../models/NotificationOutbox');
            await NotificationOutbox.create({
                aggregateType: 'LOAN',
                aggregateId: loan._id.toString(),
                eventType: 'LOAN_CREATED',
                recipientUserId: borrowerUser._id,
                channel: 'PUSH',
                payload: {
                    title: 'New Agreement Request',
                    body: `${req.user.firstName || 'Someone'} has confirmed sending you a loan out for ₹${loan.amount}. Tap to review and accept via Digital Signature.`,
                    loanId: loan._id.toString()
                }
            });
        }

        res.status(200).json({
            success: true,
            message: 'OTP verified successfully. Sent to borrower for final approval.',
            loan
        });
    } catch (err) {
        console.error('[Loans] verifyLenderOtp Error:', err.message);
        sendError(res, err);
    }
};

// @desc    Close loan & Generate Certificate with Mutual Authentication OTP
// @route   POST /api/loans/:id/close
// @access  Private (Lender)
exports.closeLoan = async (req, res) => {
    require('../utils/asyncContext').updateTraceContext({ loanId: req.params.id });
    try {
        const { idToken } = req.body;
        const loan = await Loan.findById(req.params.id);

        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        if (loan.lender !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only lender can close this loan' });
        }

        if (loan.status === 'closed') {
            return res.status(400).json({ success: false, message: 'Loan is already closed' });
        }

        const verificationResult = await module.exports._verifyFirebaseIdToken(idToken);
        if (!verificationResult.success) {
            return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid OTP' });
        }

        const returnedPhone = verificationResult.phone.replace(/\D/g, '').slice(-10);
        const loanPhone = loan.borrowerPhone.replace(/\D/g, '').slice(-10);
        if (returnedPhone !== loanPhone) {
            return res.status(400).json({
                success: false,
                message: `OTP verified phone (+91${returnedPhone}) does not match borrower phone (+91${loanPhone})`
            });
        }

        loan.isOtpVerified = true;
        const FinancialLedgerService = require('../services/FinancialLedgerService');
        await FinancialLedgerService.writeOffAndClose(loan._id, req.user.id, null);
        
        const refreshedLoan = await Loan.findById(loan._id);
        
        try {
            const { generateAndUploadClosureCertificate } = require('../utils/pdfGenerator');
            const pdfKey = await generateAndUploadClosureCertificate(refreshedLoan);
            if (pdfKey) {
                // Store opaque storage key, NOT a public URL
                refreshedLoan.documentId = pdfKey;
                await refreshedLoan.save();
            }
        } catch (pdfErr) {
            console.error('[Loans] PDF generation failed, skipping:', pdfErr);
        }

        // Send closure confirmation email
        try {
            const borrowerUserEmail = await User.findOne({ id: loan.borrower });
            if (borrowerUserEmail && borrowerUserEmail.email) {
                await sendEmail({
                    to: borrowerUserEmail.email,
                    subject: `Credit Agreement Closed â€” â‚¹${loan.amount.toLocaleString('en-IN')}`,
                    html: loanClosedTemplate({
                        borrowerName: `${borrowerUserEmail.firstName || ''} ${borrowerUserEmail.lastName || ''}`.trim() || borrowerUserEmail.phone,
                        lenderName: req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'Your Lender',
                        amount: loan.amount,
                        closedDate: new Date().toLocaleDateString('en-IN'),
                        loanId: loan._id.toString()
                    })
                });
            }
        } catch (emailErr) {
            console.error('[Loans] closure email failed:', emailErr.message);
        }
        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        const NotificationOutbox = require('../models/NotificationOutbox');
        
        if (req.user) {
            await NotificationOutbox.create({
                aggregateType: 'LOAN',
                aggregateId: loan._id.toString(),
                eventType: 'LOAN_CLOSED',
                recipientUserId: req.user._id,
                channel: 'PUSH',
                payload: {
                    title: 'Agreement Closed',
                    body: `The loan agreement for ₹${loan.amount} has been successfully closed.`,
                    loanId: loan._id.toString()
                }
            });
        }

        const borrowerUser = await User.findOne({ id: loan.borrower });
        if (borrowerUser) {
            await NotificationOutbox.create({
                aggregateType: 'LOAN',
                aggregateId: loan._id.toString(),
                eventType: 'LOAN_CLOSED',
                recipientUserId: borrowerUser._id,
                channel: 'PUSH',
                payload: {
                    title: 'Agreement Closed',
                    body: `Your loan agreement for ₹${loan.amount} has been successfully closed.`,
                    loanId: loan._id.toString()
                }
            });
        }

        const legacyTxs = await fetchV2TransactionsAsLegacy(loan._id);
        res.status(200).json({ success: true, message: 'Loan successfully closed.', loan: serializeLoan(refreshedLoan || loan), transactions: legacyTxs });
    } catch (err) {
        console.error('[Loans] closeLoan Error:', err.message);
        sendError(res, err);
    }
};

// @desc    Upload document
// @route   POST /api/loans/upload-document
// @access  Private
exports.uploadDocument = async (req, res) => {
    try {
        const { fileName, fileType, base64Data } = req.body;

        // Security: validate file extension
        const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'];
        const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
        
        // Sanitize filename â€” strip directory traversal, allow only safe chars
        const sanitizedName = (fileName || 'document')
            .replace(/[^a-zA-Z0-9._\-]/g, '_')
            .replace(/\.\./g, '')
            .substring(0, 100);
        
        const ext = require('path').extname(sanitizedName).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
            return res.status(400).json({
                success: false,
                message: `File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
            });
        }
        
        if (!ALLOWED_MIME_TYPES.includes(fileType)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid file MIME type'
            });
        }
        
        // Validate base64 size (max 4MB decoded)
        const estimatedSize = (base64Data.length * 3) / 4;
        if (estimatedSize > 4 * 1024 * 1024) {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is 4MB.'
            });
        }

        if (!fileName || !fileType || !base64Data) {
            return res.status(400).json({ success: false, message: 'Please provide fileName, fileType and base64Data' });
        }

        const buffer = Buffer.from(base64Data, 'base64');
        try {
            const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
            const bucket = admin.storage().bucket(bucketName);
            // Opaque UUID storage key — original filename never exposed
            const { v4: uuidv4 } = require('uuid');
            const storageKey = `documents/${uuidv4()}${require('path').extname(sanitizedName).toLowerCase()}`;
            const file = bucket.file(storageKey);

            await file.save(buffer, {
                metadata: {
                    contentType: fileType || 'image/jpeg',
                    metadata: { uploadedBy: req.user ? req.user.id : 'unknown' }
                }
                // SECURITY FIX: NO public: true — object is private by default
            });
            // SECURITY FIX: NO file.makePublic()
            // SECURITY FIX: NO public URL — return opaque documentId only
            console.log(`[Upload] Uploaded privately to Firebase: ${storageKey}`);
            return res.status(200).json({ success: true, documentId: storageKey });
        } catch (firebaseError) {
            console.error('[Upload] Firebase upload failed:', firebaseError.message);

            // Fallback: local storage, opaque UUID key, NOT a public HTTP URL
            const uploadsDir = path.join(__dirname, '..', 'uploads');
            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
            }
            const { v4: uuidv4 } = require('uuid');
            const localFilename = `${uuidv4()}${require('path').extname(sanitizedName).toLowerCase()}`;
            const localPath = path.join(uploadsDir, localFilename);
            fs.writeFileSync(localPath, buffer);
            const localDocumentId = `local/${localFilename}`;
            console.log(`[Upload] Fallback: saved locally with key ${localDocumentId}`);
            return res.status(200).json({ success: true, documentId: localDocumentId });
        }
    } catch (err) {
        console.error('[Upload] Controller Error:', err.message);
        return sendError(res, err);
    }
};

// â”€â”€â”€ Custom Payment Transactions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.recordPayment = async (req, res) => {
    require('../utils/asyncContext').updateTraceContext({ loanId: req.params.id });
    try {
        const loanId = req.params.id;
        const amountPaise = Number(req.body.amountPaise); // Strictly validated by isInt in validatePaymentAmount
        
        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.recordPayment(loanId, amountPaise, req.user.id, null);
        
        // Return matching response format for backward compatibility
        const legacyTxs = await fetchV2TransactionsAsLegacy(result.loan._id);
        res.status(200).json({ success: true, loan: serializeLoan(result.loan), transactions: legacyTxs });
    } catch (err) {
        if (err.message.includes('OVERPAYMENT_REJECTED')) {
            return res.status(400).json({ success: false, message: 'Cannot pay more than outstanding balance' });
        }
        console.error('[Loans] recordPayment Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.addCredit = async (req, res) => {
    require('../utils/asyncContext').updateTraceContext({ loanId: req.params.id });
    try {
        const loanId = req.params.id;
        const amountPaise = Number(req.body.amountPaise); // Strictly validated by isInt in validatePaymentAmount
        
        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const { intentId, idToken } = req.body;
        if (!intentId || !idToken) return res.status(400).json({ success: false, message: 'Intent ID and OTP required' });
        const { verifyFirebaseIdToken } = require('../middleware/auth');
        const vResult = await module.exports._verifyFirebaseIdToken(idToken);
        if (!vResult.success) return res.status(400).json({ success: false, message: 'Invalid OTP' });
        const Loan = require('../models/Loan');
        const currentLoan = await Loan.findById(loanId);
        if (vResult.phone.replace(/\D/g, '').slice(-10) !== currentLoan.borrowerPhone.replace(/\D/g, '').slice(-10)) return res.status(400).json({ success: false, message: 'OTP phone mismatch' });
        const result = await FinancialLedgerService.addCredit(loanId, amountPaise, req.user.id, intentId);
        
        const legacyTxs = await fetchV2TransactionsAsLegacy(result.loan._id);
        res.status(200).json({ success: true, loan: serializeLoan(result.loan), transactions: legacyTxs });
    } catch (err) {
        console.error('[Loans] addCredit Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};



// @desc    Toggle month status for simple visual tracking
// @route   PATCH /api/loans/:id/months/:monthIndex
// @access  Private (Lender)
exports.toggleMonthStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const monthIndex = parseInt(req.params.monthIndex);
        const loan = await require('../models/Loan').findById(req.params.id);
        
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        if (loan.lender !== req.user.id) return res.status(403).json({ success: false, message: 'Only lender can update timeline' });
        
        const monthObj = loan.monthsTracking.find(m => m.monthIndex === monthIndex);
        if (monthObj) {
            monthObj.status = status;
            if (status === 'paid') {
                monthObj.markedPaidAt = new Date();
                monthObj.markedBy = req.user.id;
            } else {
                monthObj.markedPaidAt = undefined;
                monthObj.markedBy = undefined;
            }
        } else {
            // Push new month if missing
            loan.monthsTracking.push({
                monthIndex,
                status,
                markedPaidAt: status === 'paid' ? new Date() : undefined,
                markedBy: status === 'paid' ? req.user.id : undefined
            });
        }
        
        await loan.save();
        await require('../config/redis').cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);
        
        res.status(200).json({ success: true, loan: serializeLoan(loan) });
    } catch (err) {
        console.error('[Loans] toggleMonthStatus Error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};


exports.getPortfolioSummary = async (req, res) => {
    try {
        const lenderId = req.user.id;
        const summary = await require('../models/Loan').aggregate([
            { $match: { lender: lenderId } },
            {
                $group: {
                    _id: null,
                    loanCount: { $sum: 1 },
                    activeLoanCount: {
                        $sum: { $cond: [{ $in: ['$status', ['active', 'due_soon', 'overdue']] }, 1, 0] }
                    },
                    totalLentPaise: {
                        $sum: {
                            $cond: [
                                { $in: ['$status', ['pending_approval', 'pending_otp', 'rejected']] },
                                0,
                                { $ifNull: ['$amountPaise', { $multiply: ['$amount', 100] }] }
                            ]
                        }
                    },
                    totalCollectedPaise: {
                        $sum: { $ifNull: ['$paidAmountPaise', { $multiply: [{ $ifNull: ['$paidAmount', 0] }, 100] }] }
                    },
                    outstandingPaise: {
                        $sum: {
                            $cond: [
                                { $in: ['$status', ['pending_approval', 'pending_otp', 'rejected']] },
                                0,
                                {
                                    $let: {
                                        vars: {
                                            payable: { $ifNull: ['$totalPayablePaise', { $multiply: [{ $ifNull: ['$totalPayable', 0] }, 100] }] },
                                            paid: { $ifNull: ['$paidAmountPaise', { $multiply: [{ $ifNull: ['$paidAmount', 0] }, 100] }] }
                                        },
                                        in: { $max: [0, { $subtract: ['$$payable', '$$paid'] }] }
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        ]);
        
        let data = { loanCount: 0, activeLoanCount: 0, totalLentPaise: 0, totalCollectedPaise: 0, outstandingPaise: 0 };
        if (summary.length > 0) {
            const s = summary[0];
            data = {
                loanCount: s.loanCount || 0,
                activeLoanCount: s.activeLoanCount || 0,
                totalLentPaise: Math.round(s.totalLentPaise || 0),
                totalCollectedPaise: Math.round(s.totalCollectedPaise || 0),
                outstandingPaise: Math.round(s.outstandingPaise || 0)
            };
        }
        res.status(200).json({ success: true, data, meta: { lastVerifiedAt: new Date().toISOString() } });
    } catch (err) {
        console.error('[PortfolioSummary] Error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};


// Helper for accurate calendar month addition avoiding JS rollover drift
function addCalendarMonths(date, months) {
    const d = new Date(date);
    const expectedMonth = (d.getMonth() + months) % 12;
    d.setMonth(d.getMonth() + months);
    if (d.getMonth() !== expectedMonth) {
        d.setDate(0); // Roll back to last day of the intended month
    }
    return d;
}

// @desc    Get flexible repayment timeline projection for a loan
// @route   GET /api/loans/:id/repayment-timeline
// @access  Private (Lender & Borrower)

exports.getInterestSchedule = async (req, res) => {
    try {
        const loan = await require('../models/Loan').findById(req.params.id);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const Transaction = require('../models/Transaction');
        
        // Fetch all relevant transactions for the loan
        const txs = await Transaction.find({ 
            loanId: loan._id,
            type: { $in: ['INTEREST_ACCRUED', 'PAYMENT', 'REVERSAL'] }
        }).sort({ effectiveAt: 1 });
        
        const scheduleMap = new Map();
        
        for (const tx of txs) {
            if (tx.type === 'INTEREST_ACCRUED') {
                const date = new Date(tx.accrualEnd || tx.effectiveAt);
                const monthKey = `${date.toLocaleString('default', { month: 'long' })} ${date.getFullYear()}`;
                
                if (!scheduleMap.has(monthKey)) {
                    scheduleMap.set(monthKey, { month: monthKey, accruedPaise: 0, paidPaise: 0 });
                }
                scheduleMap.get(monthKey).accruedPaise += tx.amountPaise;
            } else if (tx.type === 'PAYMENT' && tx.interestDeltaPaise < 0) {
                const date = new Date(tx.effectiveAt);
                const monthKey = `${date.toLocaleString('default', { month: 'long' })} ${date.getFullYear()}`;
                
                if (!scheduleMap.has(monthKey)) {
                    scheduleMap.set(monthKey, { month: monthKey, accruedPaise: 0, paidPaise: 0 });
                }
                scheduleMap.get(monthKey).paidPaise += Math.abs(tx.interestDeltaPaise);
            } else if (tx.type === 'REVERSAL' && tx.interestDeltaPaise > 0) {
                // If a payment was reversed, the reversal restores interest balance (positive delta)
                const date = new Date(tx.effectiveAt);
                const monthKey = `${date.toLocaleString('default', { month: 'long' })} ${date.getFullYear()}`;
                
                if (!scheduleMap.has(monthKey)) {
                    scheduleMap.set(monthKey, { month: monthKey, accruedPaise: 0, paidPaise: 0 });
                }
                scheduleMap.get(monthKey).paidPaise -= Math.abs(tx.interestDeltaPaise);
            }
        }
        
        const schedule = Array.from(scheduleMap.values());
        
        // Calculate totals
        let totalAccrued = 0;
        let totalPaid = 0;
        for (const s of schedule) {
            totalAccrued += s.accruedPaise;
            totalPaid += s.paidPaise;
        }

        return res.status(200).json({
            success: true,
            totalAccruedPaise: totalAccrued,
            totalPaidPaise: totalPaid,
            outstandingInterestPaise: loan.interestOutstandingPaise,
            originalPrincipalPaise: loan.agreementSnapshot ? loan.agreementSnapshot.expectedPrincipalPaise : loan.amount * 100,
            interestRateBps: loan.agreementSnapshot ? loan.agreementSnapshot.interestRateBps : loan.interestRate * 100,
            interestMethod: loan.agreementSnapshot ? loan.agreementSnapshot.interestMethod : 'SIMPLE_ORIGINAL_PRINCIPAL',
            schedule
        });

    } catch (err) {
        console.error('[InterestSchedule] Error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getRepaymentTimeline = async (req, res) => {
    try {
        const loan = await require('../models/Loan').findById(req.params.id);
        
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        // IDOR Protection: Only the lender or borrower can view this
        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Unauthorized access to loan timeline' });
        }

        // Feature is explicitly disabled for Chit loans
        if (loan.loanType === 'chit') {
            return res.status(200).json({
                success: true,
                trackingEnabled: false,
                reason: 'UNSUPPORTED_LOAN_TYPE'
            });
        }

        // A loan must be active/completed to have a timeline. Pending loans don't have an activatedAt anchor.
        if (['pending_approval', 'pending_otp', 'rejected'].includes(loan.status)) {
            return res.status(200).json({
                success: true,
                trackingEnabled: false,
                reason: 'LOAN_NOT_ACTIVE'
            });
        }

        let anchor = loan.activatedAt;
        let anchorSource = 'activatedAt';
        if (!anchor) {
            anchor = loan.startDate;
            anchorSource = 'startDate';
        }
        if (!anchor) {
            anchor = loan._id.getTimestamp();
            anchorSource = 'createdAt';
        }
        const durationMonths = loan.durationMonths || 0;

        const timeline = [];
        for (let i = 1; i <= durationMonths; i++) {
            timeline.push({
                periodIndex: i,
                periodStart: addCalendarMonths(anchor, i - 1),
                periodEnd: addCalendarMonths(anchor, i),
                status: 'NO_PAYMENT_RECORDED',
                hasPayments: false,
                totalPaidPaise: 0,
                transactions: []
            });
        }

        const postTermTransactions = [];

        // Project transactions onto periods
        const transactions = loan.transactions || [];
        for (const tx of transactions) {
            // Only aggregate payments
            if (tx.type === 'payment' || tx.type === 'interest_payment' || tx.type === 'credit_added') {
                const txDate = new Date(tx.recordedAt);
                let matched = false;

                for (const period of timeline) {
                    if (txDate >= period.periodStart && txDate < period.periodEnd) {
                        period.transactions.push(tx);
                        period.totalPaidPaise += (tx.amountPaise || require('../utils/money').parseRupeesToPaise(tx.amount));
                        period.hasPayments = true;
                        period.status = 'RECORDED';
                        matched = true;
                        break;
                    }
                }

                if (!matched) {
                    postTermTransactions.push(tx);
                }
            }
        }

        return res.status(200).json({
            success: true,
            trackingEnabled: true,
            data: {
                durationMonths,
                startDate: anchor,
                anchorSource,
                timeline,
                postTermTransactions
            }
        });

    } catch (err) {
        console.error('[RepaymentTimeline] Error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.sendPaymentNudge = async (req, res) => {
    try {
        const loanId = req.params.id;
        
        // Ensure strictly lender
        const Loan = require('../models/Loan');
        const User = require('../models/User');
        const Notification = require('../models/Notification');
        

        const loan = await Loan.findById(loanId);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        if (loan.lender !== req.user.id) return res.status(403).json({ success: false, message: 'Unauthorized. Only the lender can send a nudge.' });
        
        // Exclude Chits
        if (loan.loanType === 'chit') return res.status(400).json({ success: false, message: 'Nudges are not available for Chit loans.' });
        
        // Must be active
        if (['closed', 'rejected', 'pending'].includes(loan.status)) {
            return res.status(400).json({ success: false, message: 'Cannot nudge this loan at its current status.' });
        }

        const borrower = await User.findOne({ id: loan.borrower });
        if (!borrower) return res.status(404).json({ success: false, message: 'Borrower not found' });

        // Cooldown Rule: 24 hours
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentNudge = await Notification.findOne({
            userId: borrower._id,
            type: 'PAYMENT_NUDGE_SENT',
            'data.loanId': loan._id.toString(),
            createdAt: { $gte: twentyFourHoursAgo }
        });

        if (recentNudge) {
            return res.status(429).json({ success: false, message: 'A payment nudge was already sent recently. Please wait 24 hours.' });
        }
        const title = 'Payment Nudge';
        const body = 'Your lender has sent you a payment nudge. Please contact your lender to discuss your next payment.';
        if (borrower) {
            const NotificationOutbox = require('../models/NotificationOutbox');
            await NotificationOutbox.create({
                aggregateType: 'LOAN',
                aggregateId: loan._id.toString(),
                eventType: 'PAYMENT_NUDGE_SENT',
                recipientUserId: borrower._id,
                channel: 'PUSH',
                payload: {
                    title,
                    body,
                    loanId: loan._id.toString()
                }
            });
        }
        return res.status(200).json({ success: true, message: 'Payment nudge sent successfully.' });
    } catch (err) {
        console.error('[PaymentNudge] Error:', err);
        return res.status(500).json({ success: false, message: 'Server Error' });
    }
};


// @desc    Delete a pending loan request
// @route   DELETE /api/loans/:id
// @access  Private
exports.cancelLoan = async (req, res) => {
    try {
        const loan = await require('../models/Loan').findById(req.params.id);
        
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        // Must be lender or borrower
        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not authorized to cancel this loan' });
        }

        // Only PENDING loans can be cancelled. 
        if (!['pending', 'pending_approval', 'pending_otp'].includes(loan.status)) {
            return res.status(400).json({ 
                success: false, 
                code: 'MUTATION_REJECTED',
                message: 'Only pending offers can be cancelled. Loans with financial history cannot be cancelled or deleted.' 
            });
        }

        loan.status = 'cancelled';
        await loan.save();
        
        res.status(200).json({ success: true, message: 'Loan cancelled successfully', loan });
    } catch (err) {
        console.error('[Loans] Cancel Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
exports.getLoanById = async (req, res) => {
    require('../utils/asyncContext').updateTraceContext({ loanId: req.params.id });
    try {
        const { id } = req.params;
        const mongoose = require('mongoose');
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }
        const loan = await Loan.findOne({ _id: id, $or: [{ lender: req.user.id }, { borrower: req.user.id }] });
        
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }
        
        const loanObj = serializeLoan(loan);
        const User = require('../models/User');
        
        if (loanObj.borrower) {
            const borrowerUser = await User.findOne({ id: loanObj.borrower });
            if (borrowerUser) {
                loanObj.borrowerName = borrowerUser.firstName + ' ' + (borrowerUser.lastName || '');
            }
        }
        if (loanObj.lender) {
            const lenderUser = await User.findOne({ id: loanObj.lender });
            if (lenderUser) {
                loanObj.lenderName = lenderUser.firstName + ' ' + (lenderUser.lastName || '');
            }
        }
        
        if (loanObj.status === 'pending_approval' && loanObj.borrower === req.user.id) {
            const TransactionIntent = require('../models/TransactionIntent');
            const intent = await TransactionIntent.findOne({ loanId: loanObj._id, action: 'ACCEPT_LOAN', status: 'PENDING' });
            if (intent) {
                loanObj.pendingIntentId = intent.intentId;
            }
        }
        
        const legacyTxs = await fetchV2TransactionsAsLegacy(loanObj._id);
        res.status(200).json({ success: true, loan: serializeLoan(loanObj), transactions: legacyTxs });
    } catch (err) {
        console.error('[Loans] getLoanById Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
