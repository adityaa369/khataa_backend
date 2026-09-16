const Notification = require('../models/Notification');
const Loan = require('../models/Loan');
const { parseRupeesToPaise } = require('../utils/money');
const User = require('../models/User');
const { sendOtp } = require('../utils/otpProvider');
const { sendPushNotification } = require('../utils/fcm');
const { updateCreditScore } = require('../utils/creditScoreCalc');
const { sendEmail } = require('../utils/email');
const { loanGivenTemplate, paymentRecordedTemplate, loanClosedTemplate } = require('../utils/emailTemplates');
const axios = require('axios');
const { invalidateLoanCache } = require('../middleware/cache');
const { cacheGet, cacheSet, cacheInvalidate } = require('../config/redis');
const { loanSerializer, chitFundSerializer } = require('../utils/loanSerializer');

function sendError(res, err, status = 500) {
    const isProd = process.env.NODE_ENV === 'production';
    return res.status(status).json({
        success: false,
        message: isProd && status === 500 ? 'An internal error occurred' : err.message
    });
}

// Helper to verify Firebase OTP via Identity Toolkit API
async function verifyFirebaseOtp(verificationId, otp) {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) {
        return { success: false, message: 'Firebase API key not configured on server' };
    }
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=${apiKey}`;

    try {
        const response = await axios.post(url, {
            sessionInfo: verificationId,
            code: otp
        });
        
        if (response.status === 200 && response.data && response.data.phoneNumber) {
            return {
                success: true,
                phone: response.data.phoneNumber
            };
        }
        return { success: false, message: 'Invalid OTP response' };
    } catch (err) {
        console.error('[Firebase REST Auth] verification error:', err.response ? err.response.data : err.message);
        const errorMsg = err.response && err.response.data && err.response.data.error 
            ? err.response.data.error.message 
            : err.message;
        return { success: false, message: errorMsg };
    }
}

// @desc    Create a new loan
// @route   POST /api/loans
// @access  Private (Lender)
exports.createLoan = async (req, res) => {
    try {
        let {
            borrower_phone,
            borrower_name,
            borrower_aadhar,
            borrower_address,
            interest_rate,
            duration_months,
            duration_type,
            type,
            transaction_id,
            documentUrl,
            documentId,
            idempotency_key,
        } = req.body;

        // --- STRICT FINANCIAL CONTRACT ENFORCEMENT ---
        const amountPaiseRaw = req.body.amountPaise;
        const amountRaw = req.body.amount;
        let canonicalAmountPaise;

        function parseAmountToPaiseStrict(val) {
            if (val === undefined || val === null) return null;
            let str = val.toString().trim();
            if (!/^\d+(\.\d{1,2})?$/.test(str)) return null;
            const parts = str.split('.');
            const rupees = parseInt(parts[0], 10);
            let paise = 0;
            if (parts[1]) {
                paise = parseInt(parts[1].length === 1 ? parts[1] + '0' : parts[1], 10);
            }
            return (rupees * 100) + paise;
        }

        if (amountPaiseRaw !== undefined && amountPaiseRaw !== null) {
            if (!Number.isInteger(Number(amountPaiseRaw))) {
                return res.status(400).json({ success: false, message: 'amountPaise must be an integer' });
            }
            canonicalAmountPaise = Number(amountPaiseRaw);

            if (amountRaw !== undefined && amountRaw !== null) {
                const parsedLegacy = parseAmountToPaiseStrict(amountRaw);
                if (parsedLegacy === null || parsedLegacy !== canonicalAmountPaise) {
                    return res.status(400).json({ success: false, message: 'amount and amountPaise mismatch or invalid format' });
                }
            }
        } else if (amountRaw !== undefined && amountRaw !== null) {
            const parsedLegacy = parseAmountToPaiseStrict(amountRaw);
            if (parsedLegacy === null) {
                return res.status(400).json({ success: false, message: 'Invalid amount format' });
            }
            canonicalAmountPaise = parsedLegacy;
        } else {
            return res.status(400).json({ success: false, message: 'Amount is required' });
        }

        if (canonicalAmountPaise <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
        }

        // Sanitize phone: strip 91 or +91
        const amount = canonicalAmountPaise / 100;
        const borrowerPhone = borrower_phone.toString().replace(/^\+?91/, '');
        const borrowerName = borrower_name;
        const borrowerAadhar = borrower_aadhar;
        const borrowerAddress = borrower_address;
        const interestRate = interest_rate;
        const durationMonths = duration_months;
        const durationType = duration_type || 'Months';
        const loanType = type || 'personal';
        const effectiveTransactionId = transaction_id || idempotency_key;

        if (borrowerPhone === req.user.phone) {
            return res.status(400).json({
                success: false,
                message: 'You cannot give a loan to yourself'
            });
        }

        if (effectiveTransactionId) {
            const existingLoan = await Loan.findOne({ transaction_id: effectiveTransactionId, lender: req.user.id });
            if (existingLoan) {
                console.warn(`[Loans] Idempotency intercepted for transaction ${transaction_id}`);
                return res.status(200).json({
                    success: true,
                    message: 'Loan already created',
                    loan: existingLoan.toObject()
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
            amountPaise: canonicalAmountPaise,
            createdAt: { $gte: twoMinsAgo }
        });

        if (duplicateLoan) {
            console.warn(`[Loans] Duplicate loan creation attempt intercepted for ${borrowerPhone}`);
            return res.status(429).json({
                success: false,
                message: 'Duplicate loan request detected. Please wait a moment.'
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
            amountPaise: canonicalAmountPaise,
            interestRate,
            durationMonths,
            durationType,
            loanType,
            status: 'pending_approval',
            transaction_id: effectiveTransactionId,
            documentUrl,
            documentId
        });
        
        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        const lenderName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'A lender';

        // Send FCM alert telling borrower setup has been initiated
        if (borrower.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            Notification.create({ userId: borrower._id, title: 'Lender Setup Verification', body: `A credit agreement setup for ₹${amount} has been initiated by ${lenderName}.`, data: { type: 'LOAN_INIT_OTP', loanId: loan._id.toString() } }).catch(err => console.log('Notification DB Error', err));
            sendPushNotification(
                borrower.fcmToken,
                'Lender Setup Verification',
                `A credit agreement setup for ₹${amount} has been initiated by ${lenderName}.`,
                { type: 'LOAN_INIT_OTP', loanId: loan._id.toString() }
            ).catch(fcmErr => {
                console.error('[Loans] FCM init setup push notification failed:', fcmErr.message);
            });
        }

        const loanResponse = loan.toObject();
        loanResponse.id = loan._id.toString();

        res.status(201).json({
            success: true,
            message: 'Loan agreement initiated. OTP sent to borrower.',
            loan: loanResponse
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

        const loans = await Loan.find({ lender: req.user.id, status: { $ne: 'pending_otp' } });
        const loansMapped = [];
        const User = require('../models/User'); // Import User model
        for (const loan of loans) {
            const loanObj = loan.toObject ? loan.toObject() : loan;
            
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
            
            loansMapped.push(loanSerializer(loanObj));
        }
        
        // --- CHIT FUNDS AGGREGATION ---
        const ChitFund = require('../models/ChitFund');
        const ownedChits = await ChitFund.find({ owner: req.user.id });

        for (const chit of ownedChits) {
            loansMapped.push(chitFundSerializer(chit, {
                status: chit.status === 'completed' ? 'completed' : 'active',
                progress: (chit.completedMonths || 0) / (chit.totalMonths || 1),
                startDate: chit.startDate || chit.createdAt,
                lenderName: `${req.user.firstName || ''} ${req.user.lastName || ''}`,
                borrowerName: `${chit.currentSubscribersCount} Member(s)`,
                borrowerPhone: 'N/A',
                createdAt: chit.createdAt
            }));
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
exports.getLoanById = async (req, res) => {
    try {
        const loan = await Loan.findById(req.params.id);
        if (!loan) return res.status(404).json({ success: false, message: "Loan not found" });
        
        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: "Not authorized" });
        }

        const lenderUser = await User.findOne({ id: loan.lender });
        const borrowerUser = await User.findOne({ id: loan.borrower });

        const { loanSerializer } = require("../utils/loanSerializer");
        const loanObj = loanSerializer(loan);

        if (lenderUser) {
            loanObj.lenderName = `${lenderUser.firstName || ""} ${lenderUser.lastName || ""}`.trim() || "Unknown Lender";
            loanObj.lenderPhone = lenderUser.phone;
        } else {
            loanObj.lenderName = "Unknown Lender";
            loanObj.lenderPhone = "";
        }

        if (borrowerUser) {
            loanObj.borrowerName = `${borrowerUser.firstName || ""} ${borrowerUser.lastName || ""}`.trim() || loan.borrowerName || "Unknown Borrower";
            loanObj.borrowerPhone = borrowerUser.phone;
        }

        res.status(200).json({ success: true, loan: loanObj });
    } catch (err) {
        console.error("[Loans] getLoanById Error:", err.message);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};

exports.getTakenLoans = async (req, res) => {
    try {
        const cacheKey = `loans:taken:${req.user.id}`;
        const cached = await cacheGet(cacheKey);
        if (cached) return res.status(200).json(cached);

        // Sanitize phone for query consistency
        const phone = req.user.phone.toString().replace(/^\+?91/, '');
        const loans = await Loan.find({
            borrower: req.user.id,
            lender: { $ne: req.user.id }, // Explicitly exclude loans where I am the lender
            status: { $ne: 'pending_otp' }
        });

        // Populate lender details manually to avoid changing the Mongoose schema
        const loansWithLender = [];
        for (const loan of loans) {
            const lenderUser = await User.findOne({ id: loan.lender });
            const loanObj = loan.toObject ? loan.toObject() : loan;
            if (lenderUser) {
                loanObj.lenderName = `${lenderUser.firstName || ''} ${lenderUser.lastName || ''}`.trim() || 'Unknown Lender';
                loanObj.lenderPhone = lenderUser.phone || '';
            } else {
                loanObj.lenderName = 'Unknown Lender';
                loanObj.lenderPhone = '';
            }
            loansWithLender.push(loanSerializer(loanObj));
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

            loansWithLender.push(chitFundSerializer(chitFund, {
                _id: sub._id,
                status: sub.status === 'completed' ? 'completed' : 'active',
                progress: (sub.installmentsPaid || 0) / (chitFund.totalMonths || 1),
                startDate: chitFund.startDate || chitFund.createdAt,
                lenderName: ownerName,
                borrowerName: `${req.user.firstName || ''} ${req.user.lastName || ''}`,
                borrowerPhone: req.user.phone,
                createdAt: sub.createdAt
            }));
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
        const { intentId, idToken } = req.body;
        const loan = await Loan.findById(req.params.id);

        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        if (loan.status !== 'pending_approval') {
            return res.status(400).json({ success: false, message: 'Loan is not ready for approval or already active.' });
        }

        const isBorrower = loan.borrower === req.user.id;
        if (!isBorrower) return res.status(403).json({ success: false, message: 'Only the designated borrower can approve this loan.' });

        if (!idToken) return res.status(400).json({ success: false, message: 'idToken is required for financial authorization' });
        
        const { verifyFirebaseToken } = require('../utils/otpProvider');
        const verificationResult = await verifyFirebaseToken(idToken);
        if (!verificationResult.success) {
            return res.status(400).json({ success: false, message: 'Invalid ID Token' });
        }
        
        const returnedPhone = verificationResult.mobile.replace(/\D/g, '').slice(-10);
        if (returnedPhone !== String(req.user.phone).replace(/\D/g, '').slice(-10)) {
            return res.status(403).json({ success: false, message: 'ID Token identity does not match authenticated session' });
        }

        if (!intentId) return res.status(400).json({ success: false, message: 'intentId is required for this action' });
        
        const TransactionIntent = require('../models/TransactionIntent');
        const intent = await TransactionIntent.findOneAndUpdate(
            { intentId, loanId: loan._id, action: 'ACCEPT_LOAN', status: 'PENDING' },
            { status: 'COMPLETED' },
            { new: true }
        );
        
        if (!intent) {
            return res.status(400).json({ success: false, message: 'Invalid, expired, or already consumed Transaction Intent' });
        }

        loan.status = 'active';
        loan.startDate = Date.now();
        loan.activatedAt = Date.now();
        loan.borrower = req.user.id; 

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        await FinancialLedgerService.activateLoan(loan, loan.amountPaise, req.user.id, loan.activatedAt);

        // Calculate Dates
        if (loan.durationMonths && loan.durationMonths > 0) {
            const startDate = new Date(loan.startDate);
            const endDate = new Date(startDate);
            const nextDueDate = new Date(startDate);
            
            if (loan.durationType === 'Days') {
                endDate.setDate(endDate.getDate() + loan.durationMonths);
                nextDueDate.setDate(nextDueDate.getDate() + Math.min(30, loan.durationMonths));
            } else {
                endDate.setMonth(endDate.getMonth() + loan.durationMonths);
                nextDueDate.setMonth(nextDueDate.getMonth() + 1);
            }
            loan.endDate = endDate;
            loan.nextDueDate = nextDueDate;
        }

        await loan.save();

        try {
                const lenderUser = await User.findOne({ id: loan.lender });
                await sendEmail({
                    to: req.user.email,
                    subject: `Credit Agreement Activated — ₹${loan.amount.toLocaleString('en-IN')}`,
                    html: loanGivenTemplate({
                        lenderName: lenderUser ? `${lenderUser.firstName || ''} ${lenderUser.lastName || ''}`.trim() : 'Your Lender',
                        borrowerName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.phone,
                        amount: loan.amount,
                        loanType: loan.loanType || 'Credit',
                        duration: loan.durationMonths,
                        interestRate: loan.interestRate || 0,
                        startDate: new Date(loan.startDate).toLocaleDateString('en-IN')
                    })
                });
        } catch (emailErr) {
            console.error('[Loans] verifyLoan email failed:', emailErr.message);
        }
        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        const { sendPushNotification } = require('../utils/fcm');

        const lenderUser = await User.findOne({ id: loan.lender });
        if (lenderUser && lenderUser.fcmToken) {
            sendPushNotification(
                lenderUser.fcmToken,
                'Agreement Accepted',
                `${req.user.firstName || 'A borrower'} has signed and accepted your loan agreement for ₹${loan.amount}.`,
                { type: 'LOAN_VERIFIED', loanId: loan._id.toString() }
            ).catch(err => console.error('[Loans] FCM Lender verify notification failed:', err.message));
        }

        if (req.user && req.user.fcmToken) {
            sendPushNotification(
                req.user.fcmToken,
                'Agreement Activated',
                `Your loan agreement for ₹${loan.amount} is now active and on track.`,
                { type: 'LOAN_VERIFIED', loanId: loan._id.toString() }
            ).catch(err => console.error('[Loans] FCM Borrower verify notification failed:', err.message));
        }
        
        console.log('--- END DEBUG ---\n');

        res.status(200).json({ success: true, loan });
    } catch (err) {
        console.error('[Loans] verifyLoan Error:', err.message);
        sendError(res, err);
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
            if (borrowerUser && borrowerUser.fcmToken) {
                const { sendPushNotification } = require('../utils/fcm');
                sendPushNotification(
                    borrowerUser.fcmToken,
                    'Loan Progress Updated',
                    `Your lender has updated the repayment progress for your loan of ₹${loan.amount}.`,
                    { type: 'LOAN_PROGRESS_UPDATED', loanId: loan._id.toString() }
                ).catch(err => console.error('[Loans] FCM updateProgress notification failed:', err.message));
            }
        }

        res.status(200).json({ success: true, loan });
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
        const { idToken, otp, verificationId } = req.body;
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

        let returnedPhone;

        if (idToken) {
            const { verifyFirebaseToken } = require('../utils/otpProvider');
            const verificationResult = await verifyFirebaseToken(idToken);
            if (!verificationResult.success) {
                return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid ID Token' });
            }
            returnedPhone = verificationResult.mobile.replace(/\D/g, '').slice(-10);
        } else if (verificationId && otp) {
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) {
                return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid OTP' });
            }
            returnedPhone = verificationResult.phone.replace(/\D/g, '').slice(-10);
        } else {
            return res.status(400).json({ success: false, message: 'idToken or verificationId is required' });
        }
        const loanPhone = loan.borrowerPhone.replace(/\D/g, '').slice(-10);
        if (returnedPhone !== loanPhone) {
            return res.status(400).json({
                success: false,
                message: `OTP verified phone (+91${returnedPhone}) does not match borrower phone (+91${loanPhone})`
            });
        }

        loan.status = 'pending_approval';
        loan.isOtpVerified = true;
        await loan.save();
        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        // Now trigger the Push Notification to the borrower
        const borrowerUser = await User.findOne({ id: loan.borrower });
        if (borrowerUser && borrowerUser.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            sendPushNotification(
                borrowerUser.fcmToken,
                'New Agreement Request',
                `${req.user.firstName || 'Someone'} has confirmed sending you a loan out for ₹${loan.amount}. Tap to review and accept via Digital Signature.`,
                { type: 'LOAN_CREATED', loanId: loan._id.toString() }
            ).catch(err => console.error('[Loans] FCM verifyLenderOtp notification failed:', err.message));
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

// @desc    Close loan
// @route   POST /api/loans/:id/close
// @access  Private (Lender)
exports.closeLoan = async (req, res) => {
    try {
        const { intentId } = req.body;
        const Loan = require('../models/Loan');
        const TransactionIntent = require('../models/TransactionIntent');
        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const { cacheInvalidate } = require('../middleware/cache');
        const { invalidateLoanCache } = require('../utils/cacheUtils');

        const loan = await Loan.findById(req.params.id);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        if (loan.lender !== req.user.id) return res.status(403).json({ success: false, message: 'Only lender can close this loan' });
        if (loan.status === 'closed') return res.status(200).json({ success: true, message: 'Loan is already closed', loan });

        if (!intentId) return res.status(400).json({ success: false, message: 'intentId is required' });

        // Atomic upsert to prevent race conditions
        let intent = await TransactionIntent.findOneAndUpdate(
            { intentId },
            {
                $setOnInsert: {
                    intentId,
                    loanId: loan._id,
                    action: 'CLOSE_LOAN',
                    userId: req.user.id,
                    status: 'PENDING'
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        if (intent.status === 'COMMITTED') {
            return res.status(200).json({ success: true, message: 'Loan successfully closed (idempotent).', loan });
        } else if (intent.status === 'REJECTED') {
            return res.status(400).json({ success: false, message: 'Transaction intent was previously rejected' });
        }

        try {
            await FinancialLedgerService.closeLoan(loan, new Date());
        } catch (e) {
            intent.status = 'REJECTED';
            await intent.save();
            return res.status(400).json({ success: false, message: e.message });
        }

        loan.status = 'closed';
        loan.progress = 1.0;
        await loan.save();

        intent.status = 'COMMITTED';
        await intent.save();

        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        res.status(200).json({ success: true, message: 'Loan successfully closed.', loan });
    } catch (err) {
        console.error('[Loans] closeLoan Error:', err.message);
        const { sendError } = require('../utils/response');
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
        
        // Sanitize filename
        const sanitizedName = (fileName || 'document')
            .replace(/[^a-zA-Z0-9._\-]/g, '_')
            .replace(/\.\./g, '')
            .substring(0, 100);
        
        const ext = require('path').extname(sanitizedName).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext) && ext !== '') {
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
        
        // Validate base64 size (max 5MB decoded)
        const estimatedSize = (base64Data.length * 3) / 4;
        if (estimatedSize > 5 * 1024 * 1024) {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is 5MB.'
            });
        }

        if (!fileName || !fileType || !base64Data) {
            return res.status(400).json({ success: false, message: 'Please provide fileName, fileType and base64Data' });
        }

        const buffer = Buffer.from(base64Data, 'base64');
        const GridFSService = require('../services/GridFSService');
        
        const documentId = await GridFSService.uploadDocument(buffer, sanitizedName, fileType, {
            uploadedBy: req.user.id,
            size: buffer.length,
            createdAt: new Date()
        });

        console.log(`[Upload] Uploaded successfully to GridFS: ${documentId}`);
        return res.status(200).json({ success: true, documentId: documentId.toString() });

    } catch (err) {
        console.error('[Upload] Upload failed:', err.message);
        return res.status(500).json({ success: false, message: 'Server error during upload' });
    }
};



// Custom Payment Transactions
async function _handleCustomTransaction(req, res, actionType) {
    try {
        const { amountPaise, idToken, intentId } = req.body;
        // Fallback for strict amount parsing
        const pa = amountPaise || (req.body.amount ? Math.round(req.body.amount * 100) : 0);

        const loan = await Loan.findById(req.params.id);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        if (loan.lender !== req.user.id) return res.status(403).json({ success: false, message: 'Only lender can update this loan' });
        if (loan.status === 'closed') return res.status(400).json({ success: false, message: 'Loan is already closed' });
        if (!pa || pa <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });
        
        if (!idToken) return res.status(400).json({ success: false, message: 'idToken is required' });
        const { verifyFirebaseToken } = require('../utils/otpProvider');
        const verificationResult = await verifyFirebaseToken(idToken);
        if (!verificationResult.success) {
            return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid ID Token' });
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        
        let notifTitle = 'Transaction Complete', notifBody = '';
        if (actionType === 'recordPayment' || actionType === 'recordInterest') {
            await FinancialLedgerService.recordPayment(loan, pa, intentId, req.user.id);
            notifTitle = 'Payment Recorded';
            notifBody = `Your lender recorded a payment of Rs.${pa / 100}. Remaining: Rs.${loan.totalPayablePaise / 100}.`;
        } else if (actionType === 'addCredit') {
            await FinancialLedgerService.addCredit(loan, pa, intentId, req.user.id);
            notifTitle = 'Credit Added';
            notifBody = `Your lender added Rs.${pa / 100}. Total payable: Rs.${loan.totalPayablePaise / 100}.`;
        }
        
        await loan.save();
        const { invalidateLoanCache } = require('../utils/cacheUtils');
        await invalidateLoanCache(loan.lender, loan.borrower);
        
        if (loan.borrower) {
            const { updateCreditScore } = require('../utils/creditScore');
            await updateCreditScore(loan.borrower);
            const User = require('../models/User');
            const borrowerUser = await User.findOne({ id: loan.borrower });
            if (borrowerUser && borrowerUser.fcmToken) {
                const { sendPushNotification } = require('../utils/fcm');
                sendPushNotification(borrowerUser.fcmToken, notifTitle, notifBody, { type: 'LOAN_TRANSACTION', loanId: loan._id.toString() }).catch(()=>{});
            }
        }
        res.status(200).json({ success: true, loan });
    } catch (err) {
        console.error('[Loans] customTransaction Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
}
exports.recordPayment = (req, res) => _handleCustomTransaction(req, res, 'recordPayment');
exports.addCredit = (req, res) => _handleCustomTransaction(req, res, 'addCredit');
exports.recordInterest = (req, res) => _handleCustomTransaction(req, res, 'recordInterest');

exports.getInterestSchedule = async (req, res) => {
    try {
        const Loan = require('../models/Loan');
        const loan = await Loan.findById(req.params.id);
        
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }
        
        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this schedule' });
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        await FinancialLedgerService.accrueInterest(loan, new Date());
        FinancialLedgerService.deriveBalances(loan);

        const startDate = loan.activatedAt || loan.startDate || loan.createdAt;
        const durationMonths = loan.durationMonths || 0;
        
        const monthlyBuckets = {};
        
        const getMonthKey = (date) => {
            const d = new Date(date);
            return d.toLocaleString('default', { month: 'short' }) + ' ' + d.getFullYear();
        };

        loan.transactions.forEach(t => {
            const date = t.effectiveAt || t.recordedAt;
            const key = getMonthKey(date);
            if (!monthlyBuckets[key]) {
                monthlyBuckets[key] = {
                    month: key,
                    businessDate: date,
                    accruedPaise: 0,
                    paidPaise: 0,
                    principalPaidPaise: 0
                };
            }
            if (t.type === 'interest_accrued') {
                monthlyBuckets[key].accruedPaise += (t.amountPaise || 0);
            }
            if (t.type === 'payment' || t.type === 'interest_payment') {
                monthlyBuckets[key].paidPaise += (t.interestAllocationPaise || 0);
                monthlyBuckets[key].principalPaidPaise += (t.principalAllocationPaise || 0);
            }
        });

        const historicalSchedule = Object.values(monthlyBuckets).sort((a, b) => new Date(a.businessDate) - new Date(b.businessDate));
        
        let totalAccruedPaise = 0;
        let totalPaidPaise = 0;
        
        historicalSchedule.forEach(p => {
            totalAccruedPaise += p.accruedPaise;
            totalPaidPaise += p.paidPaise;
        });

        let projectedPrincipalPaise = loan.principalOutstandingPaise;
        const ratePct = loan.interestRate || 0;
        const projectedSchedule = [];
        
        if (projectedPrincipalPaise > 0 && ratePct > 0) {
            const endDate = new Date(startDate);
            endDate.setMonth(endDate.getMonth() + durationMonths);
            
            let currentDate = new Date();
            if (loan.status === 'active') {
                while (currentDate < endDate) {
                    currentDate.setMonth(currentDate.getMonth() + 1);
                    const key = getMonthKey(currentDate);
                    if (!monthlyBuckets[key]) {
                        const projectedInterest = Math.floor(projectedPrincipalPaise * ratePct * 12 * 30 / 365 / 100);
                        projectedSchedule.push({
                            month: key,
                            businessDate: new Date(currentDate),
                            dueDate: new Date(currentDate),
                            openingPrincipalPaise: projectedPrincipalPaise,
                            accruedPaise: projectedInterest,
                            interestAccruedPaise: projectedInterest,
                            paidPaise: 0,
                            interestPaidPaise: 0,
                            principalPaidPaise: 0,
                            closingPrincipalPaise: projectedPrincipalPaise,
                            status: 'projected'
                        });
                    }
                }
            }
        }

        const fullSchedule = [...historicalSchedule, ...projectedSchedule].map(p => ({
            ...p,
            interestAccruedPaise: p.accruedPaise,
            interestPaidPaise: p.paidPaise,
            status: p.status || 'historical'
        }));

        res.status(200).json({
            success: true,
            principalOutstandingPaise: loan.principalOutstandingPaise,
            accruedInterestPaise: totalAccruedPaise,
            interestOutstandingPaise: loan.interestOutstandingPaise,
            interestPaidPaise: totalPaidPaise,
            
            totalAccruedPaise: totalAccruedPaise,
            totalPaidPaise: totalPaidPaise,
            outstandingInterestPaise: loan.interestOutstandingPaise,
            originalPrincipalPaise: loan.amountPaise,
            interestRateBps: Math.floor(ratePct * 100),
            interestMethod: 'ACT/365 Exact (Reducing Balance)',
            
            schedule: fullSchedule
        });

    } catch (err) {
        console.error('[Loans] getInterestSchedule Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

