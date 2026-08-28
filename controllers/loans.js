const Notification = require('../models/Notification');
const Loan = require('../models/Loan');
const User = require('../models/User');
const { sendOtp } = require('../utils/otpProvider');
const { sendPushNotification } = require('../utils/fcm');
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
            amount,
            interest_rate,
            duration_months,
            duration_type,
            type,
            transaction_id,
            documentUrl
        } = req.body;

        // Sanitize phone: strip 91 or +91
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
            interestRate,
            durationMonths,
            durationType,
            loanType,
            status: 'pending_otp',
            transaction_id,
            documentUrl,
            otp: 'FIREBASE_OTP',
            isOtpVerified: false,
            monthsTracking
        });
        
        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        const lenderName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'A lender';

        // Send FCM alert telling borrower setup has been initiated
        if (borrower.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            Notification.create({ userId: borrower._id, title: 'Lender Setup Verification', body: `A credit agreement setup for â‚¹${amount} has been initiated by ${lenderName}.`, data: { type: 'LOAN_INIT_OTP', loanId: loan._id.toString() } }).catch(err => console.log('Notification DB Error', err));
            sendPushNotification(
                borrower.fcmToken,
                'Lender Setup Verification',
                `A credit agreement setup for â‚¹${amount} has been initiated by ${lenderName}.`,
                { type: 'LOAN_INIT_OTP', loanId: loan._id.toString() }
            ).catch(fcmErr => {
                console.error('[Loans] FCM init setup push notification failed:', fcmErr.message);
            });
        }

        const loanResponse = loan.toObject();

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

        const loans = await Loan.find({ lender: req.user.id });
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
            
            loansMapped.push(loanObj);
        }
        
        // --- CHIT FUNDS AGGREGATION ---
        const ChitFund = require('../models/ChitFund');
        const ownedChits = await ChitFund.find({ owner: req.user.id });

        for (const chit of ownedChits) {
            loansMapped.push({
                _id: chit._id,
                loanType: 'chitfund',
                amount: chit.totalValue,
                interestRate: 0,
                durationMonths: chit.totalMonths,
                status: chit.status === 'completed' ? 'completed' : 'active',
                progress: (chit.completedMonths || 0) / (chit.totalMonths || 1),
                startDate: chit.startDate || chit.createdAt,
                endDate: null,
                lenderName: `${req.user.firstName || ''} ${req.user.lastName || ''}`,
                borrowerName: `${chit.currentSubscribersCount} Member(s)`,
                borrowerPhone: 'N/A',
                emiAmount: chit.monthlySubscription,
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
            const loanObj = loan.toObject ? loan.toObject() : loan;
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
        const { otp } = req.body; // Deprecated OTP validation fallback
        const loanId = req.params.id;

        const { loan, notifyParams } = await withTransaction(async (session) => {
            const loanRecord = await Loan.findById(loanId).session(session);
            if (!loanRecord) throw new Error('LOAN_NOT_FOUND');
            if (loanRecord.borrowerPhone !== req.user.phone) throw new Error('UNAUTHORIZED');
            
            // STRICT STATE MACHINE GUARD
            if (loanRecord.status !== 'pending_approval') {
                throw new Error('INVALID_STATE_TRANSITION');
            }

            loanRecord.status = 'active';
            trackFinancialEvent('LOAN_ACCEPTED', { loanId: loanRecord._id });
            loanRecord.activatedAt = new Date();
            loanRecord.borrower = req.user.id;
            
            if (!loanRecord.transactions) loanRecord.transactions = [];
            loanRecord.transactions.push({
                type: 'loan_given',
                amount: loanRecord.amount,
                amountPaise: loanRecord.amountPaise,
                note: 'Loan activated and accepted by borrower',
                recordedAt: new Date(),
                recordedBy: req.user.id
            });

            await loanRecord.save({ session });
            
            return {
                loan: loanRecord,
                notifyParams: { lenderId: loanRecord.lender, borrowerName: loanRecord.borrowerName }
            };
        });

        // External side-effects
        await invalidateLoanCache(notifyParams.lenderId, loan.borrower);
        
        res.status(200).json({ success: true, loan });
    } catch (err) {
        if (err.message === 'INVALID_STATE_TRANSITION') return res.status(400).json({ success: false, message: 'Loan cannot be activated from its current state.'});
        if (err.message === 'UNAUTHORIZED') return res.status(403).json({ success: false, message: 'You are not authorized to verify this loan.'});
        if (err.message === 'LOAN_NOT_FOUND') return res.status(404).json({ success: false, message: 'Loan not found.'});

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
                    `Your lender has updated the repayment progress for your loan of â‚¹${loan.amount}.`,
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
        const { otp, verificationId } = req.body;
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

        if (!verificationId) {
            return res.status(400).json({ success: false, message: 'verificationId is required' });
        }

        const verificationResult = await verifyFirebaseOtp(verificationId, otp);
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
                `${req.user.firstName || 'Someone'} has confirmed sending you a loan out for â‚¹${loan.amount}. Tap to review and accept via Digital Signature.`,
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

// @desc    Close loan & Generate Certificate with Mutual Authentication OTP
// @route   POST /api/loans/:id/close
// @access  Private (Lender)
exports.closeLoan = async (req, res) => {
    try {
        const { otp, verificationId } = req.body;
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

        if (!verificationId) {
            return res.status(400).json({ success: false, message: 'verificationId is required' });
        }

        const verificationResult = await verifyFirebaseOtp(verificationId, otp);
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

        loan.status = 'completed';
        loan.progress = 1.0;
        loan.isOtpVerified = true; // reusing field just to mark full authentication
        
        
        try {
            const { generateAndUploadClosureCertificate } = require('../utils/pdfGenerator');
            const pdfUrl = await generateAndUploadClosureCertificate(loan);
            if (pdfUrl) {
                // If there's an existing document string, we append or replace. We'll replace it.
                loan.documentUrl = pdfUrl; 
            }
        } catch (pdfErr) {
            console.error('[Loans] PDF generation failed, skipping:', pdfErr);
        }

        await loan.save();

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

        const { sendPushNotification } = require('../utils/fcm');
        
        if (req.user && req.user.fcmToken) {
            sendPushNotification(
                req.user.fcmToken,
                'Agreement Closed',
                `The loan agreement for â‚¹${loan.amount} has been successfully closed.`,
                { type: 'LOAN_CLOSED', loanId: loan._id.toString() }
            ).catch(err => console.error('[Loans] FCM Lender close notification failed:', err.message));
        }

        const borrowerUser = await User.findOne({ id: loan.borrower });
        if (borrowerUser && borrowerUser.fcmToken) {
            sendPushNotification(
                borrowerUser.fcmToken,
                'Agreement Closed',
                `Your loan agreement for â‚¹${loan.amount} has been successfully closed.`,
                { type: 'LOAN_CLOSED', loanId: loan._id.toString() }
            ).catch(err => console.error('[Loans] FCM Borrower close notification failed:', err.message));
        }

        res.status(200).json({ success: true, message: 'Loan successfully closed.', loan });
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
            const file = bucket.file(filename);

            await file.save(buffer, {
                metadata: {
                    contentType: fileType || 'image/jpeg',
                },
                public: true
            });
            await file.makePublic();
            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
            console.log(`[Upload] Uploaded successfully to Firebase: ${publicUrl}`);
            return res.status(200).json({ success: true, url: publicUrl });
        } catch (firebaseError) {
            console.error('[Upload] Firebase upload failed (billing delinquent or config issue):', firebaseError.message);
            
            // Fallback to local storage
            const uploadsDir = path.join(__dirname, '..', 'uploads');
            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
            }

            const localFilename = `${Date.now()}_${sanitizedName}`;
            const localPath = path.join(uploadsDir, localFilename);
            fs.writeFileSync(localPath, buffer);

            // Determine server URL prefix
            const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
            const host = req.get('host');
            const localUrl = `${protocol}://${host}/uploads/${localFilename}`;
            console.log(`[Upload] Fallback: saved locally at ${localUrl}`);

            return res.status(200).json({ success: true, url: localUrl });
        }
    } catch (err) {
        console.error('[Upload] Controller Error:', err.message);
        return sendError(res, err);
    }
};

// â”€â”€â”€ Custom Payment Transactions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function _handleCustomTransaction(req, res, actionType) {
    try {
        const { amount, otp, verificationId } = req.body;
        const amountPaise = Math.round(amount * 100);
        trackFinancialEvent('LOAN_PAYMENT_STARTED', { actionType, amountPaise });
        metrics.financial.paymentsAttempted++;

        // Verify Firebase OTP first
        if (!otp || !verificationId) {
            return res.status(400).json({ success: false, message: 'OTP and verificationId are required' });
        }
        
        const currentLoanForOtp = await Loan.findById(req.params.id);
        if (!currentLoanForOtp) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }
        if (currentLoanForOtp.lender !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only lender can record payments' });
        }

        const verificationResult = await verifyFirebaseOtp(verificationId, otp);
        if (!verificationResult.success) {
            return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid OTP' });
        }

        const returnedPhone = verificationResult.phone.replace(/\D/g, '').slice(-10);
        const loanPhone = currentLoanForOtp.borrowerPhone.replace(/\D/g, '').slice(-10);
        if (returnedPhone !== loanPhone) {
            return res.status(400).json({
                success: false,
                message: `OTP verified phone (+91${returnedPhone}) does not match borrower phone (+91${loanPhone})`
            });
        }

        const { loan, notifTitle, notifBody } = await withTransaction(async (session) => {
            const currentLoan = await Loan.findById(req.params.id).session(session);
            if (!currentLoan) throw new Error('LOAN_NOT_FOUND');
            if (currentLoan.lender !== req.user.id) throw new Error('UNAUTHORIZED');
            
            let title = 'Transaction Complete';
            let body = '';

            if (actionType === 'recordPayment' || actionType === 'recordInterest') {
                if (amount > currentLoan.totalPayable || amountPaise > currentLoan.totalPayablePaise) {
                    triggerAlert('OVERPAYMENT_ATTEMPT', 'CRITICAL', { actionType, amountPaise, loanId: id });
                    metrics.financial.paymentsRejected++;
                    throw new Error('OVERPAYMENT_PROHIBITED');
                }
                
                // Float Fields
                currentLoan.totalPayable = Math.max(0, currentLoan.totalPayable - amount);
                currentLoan.paidAmount = (currentLoan.paidAmount || 0) + amount;
                
                // Paise Fields
                currentLoan.totalPayablePaise = Math.max(0, (currentLoan.totalPayablePaise || 0) - amountPaise);
                currentLoan.paidAmountPaise = (currentLoan.paidAmountPaise || 0) + amountPaise;

                title = 'Payment Recorded';
                body = `Your lender recorded a payment of ?${amount}. Your remaining balance is ?${currentLoan.totalPayable}.`;
                
                if (!currentLoan.transactions) currentLoan.transactions = [];
                currentLoan.transactions.push({
                    type: actionType === 'recordInterest' ? 'interest_payment' : 'payment',
                    amount,
                    amountPaise,
                    note: actionType === 'recordInterest' ? 'Interest payment' : 'Principal payment',
                    recordedAt: new Date(),
                    recordedBy: req.user.id
                });
            } else if (actionType === 'addCredit') {
                currentLoan.totalPayable += amount;
                currentLoan.totalPayablePaise = (currentLoan.totalPayablePaise || 0) + amountPaise;
                
                title = 'Credit Added';
                body = `Your lender added a credit of ?${amount}. Your total payable is now ?${currentLoan.totalPayable}.`;
                
                if (!currentLoan.transactions) currentLoan.transactions = [];
                currentLoan.transactions.push({
                    type: 'credit_added',
                    amount,
                    amountPaise,
                    note: 'Credit added by lender',
                    recordedAt: new Date(),
                    recordedBy: req.user.id
                });
            }

            if (currentLoan.totalPayablePaise <= 0) {
                currentLoan.status = 'completed';
                currentLoan.progress = 1.0;
            }

            await currentLoan.save({ session });
            trackFinancialEvent('LOAN_PAYMENT_COMMITTED', { loanId: currentLoan._id, amountPaise });
            metrics.financial.paymentsCommitted++;
            return { loan: currentLoan, notifTitle: title, notifBody: body };
        });

        // External Side Effects (Emails, Notifications)
        await invalidateLoanCache(loan.lender, loan.borrower);
        
        if (loan.borrower) {
            await updateCreditScore(loan.borrower);
            const borrowerUser = await User.findOne({ id: loan.borrower });
            if (borrowerUser && borrowerUser.fcmToken) {
                sendPushNotification(
                    borrowerUser.fcmToken,
                    notifTitle,
                    notifBody,
                    { type: 'LOAN_TRANSACTION', loanId: loan._id.toString() }
                ).catch(e => {});
            }
        }
        res.status(200).json({ success: true, loan, transactions: loan.transactions || [] });
    } catch (err) {
        if (err.message === 'OVERPAYMENT_PROHIBITED') return res.status(400).json({ success: false, message: 'Cannot pay more than outstanding balance' });
        sendError(res, err);
    }
}

exports.recordPayment = (req, res) => _handleCustomTransaction(req, res, 'recordPayment');
exports.addCredit = (req, res) => _handleCustomTransaction(req, res, 'addCredit');
exports.recordInterest = (req, res) => _handleCustomTransaction(req, res, 'recordInterest');

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
        
        res.status(200).json({ success: true, loan });
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
                        period.totalPaidPaise += (tx.amountPaise || Math.round(tx.amount * 100));
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
        const { sendPushNotification } = require('../utils/fcm');

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
        
        await Notification.create({
            userId: borrower._id,
            title,
            body,
            type: 'PAYMENT_NUDGE_SENT',
            data: { loanId: loan._id.toString() }
        });

        if (borrower.fcmToken) {
            sendPushNotification(borrower.fcmToken, title, body, { type: 'PAYMENT_NUDGE_SENT', loanId: loan._id.toString() })
                .catch(fcmErr => console.error('[Loans] FCM Nudge notification failed:', fcmErr.message));
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
exports.deleteLoan = async (req, res) => {
    try {
        const loan = await Loan.findById(req.params.id);
        
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        if (loan.userId.toString() !== req.user.id && loan.lenderId.toString() !== req.user.id) {
            return res.status(401).json({ success: false, message: 'Not authorized to delete this loan' });
        }

        if (!['pending_otp', 'pending_approval'].includes(loan.status)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Only pending requests can be cancelled. Active loans cannot be deleted.' 
            });
        }

        await Loan.findByIdAndDelete(req.params.id);
        
        res.status(200).json({ success: true, data: {} });
    } catch (err) {
        console.error('[Loans] Delete Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
