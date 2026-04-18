const Loan = require('../models/Loan');
const User = require('../models/User');
const { sendOtp } = require('../utils/otpProvider');
const { sendPushNotification } = require('../utils/fcm');
const { updateCreditScore } = require('../utils/creditScoreCalc');

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

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

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
            otp: otp,
            isOtpVerified: false
        });

        // Send OTP to borrower for consent verification by lender
        if (borrower.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            await sendPushNotification(
                borrower.fcmToken,
                'Lender Setup Verification',
                `A lender is establishing an agreement for ₹${amount}. Provide them this Secure OTP: ${otp}`,
                { type: 'LOAN_OTP', loanId: loan._id.toString(), otp }
            );
        }
        
        const sendResult = await sendOtp(borrowerPhone, otp);
        if (!sendResult.success) {
            console.warn(`[Loans] OTP Dispatch failed: ${sendResult.message}`);
        }

        const loanResponse = loan.toObject();

        res.status(201).json({
            success: true,
            message: 'Loan agreement initiated. OTP sent to borrower.',
            loan: loanResponse
        });
    } catch (err) {
        console.error('[Loans] createLoan Error:', err.message);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

// @desc    Get loans given by current user
// @route   GET /api/loans/given
// @access  Private
exports.getGivenLoans = async (req, res) => {
    try {
        const loans = await Loan.find({ lender: req.user.id });
        const loansMapped = [];
        for (const loan of loans) {
            loansMapped.push(loan.toObject ? loan.toObject() : loan);
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

        res.status(200).json({ success: true, loans: loansMapped });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get loans taken by current user
// @route   GET /api/loans/taken
// @access  Private
exports.getTakenLoans = async (req, res) => {
    try {
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
            } else {
                loanObj.lenderName = 'Unknown Lender';
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

        res.status(200).json({ success: true, loans: loansWithLender });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Verify/Approve loan agreement (Borrower Self-Verification)
// @route   POST /api/loans/:id/verify
// @access  Private (Borrower)
exports.verifyLoan = async (req, res) => {
    try {
        console.log('\n--- LOAN APPROVAL DEBUG ---');
        console.log('Loan ID received:', req.params.id);

        const currentUserPhone = String(req.user.phone).replace(/\D/g, '').slice(-10);
        console.log('User attempting approval:', currentUserPhone);

        const loan = await Loan.findById(req.params.id);

        if (!loan) {
            console.error(`[Loans] Loan ${req.params.id} not found.`);
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        if (loan.status !== 'pending_approval') {
            return res.status(400).json({ success: false, message: 'Loan is not ready for approval or already active.' });
        }

        const isBorrower = String(loan.borrowerPhone).replace(/\D/g, '').slice(-10) === currentUserPhone;

        if (!isBorrower) {
            return res.status(403).json({ success: false, message: 'Only the designated borrower can approve this loan.' });
        }

        loan.status = 'active';
        loan.startDate = Date.now();
        loan.activatedAt = Date.now();
        loan.borrower = req.user.id; // Link the borrower's actual user ID

        // Calculate EMI, Total Payable, and Dates
        if (loan.durationMonths && loan.durationMonths > 0) {
            const startDate = new Date(loan.startDate);

            // Set end date based on duration
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

            if (loan.interestRate > 0) {
                const P = loan.amount;
                const r = loan.interestRate / 100 / 12; // Monthly rate
                const n = loan.durationType === 'Days' ? (loan.durationMonths / 30) : loan.durationMonths;

                const emi = P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
                loan.emiAmount = emi;
                loan.totalPayable = emi * (loan.durationType === 'Days' ? 1 : n);
            } else {
                loan.emiAmount = loan.amount / loan.durationMonths;
                loan.totalPayable = loan.amount;
            }
        } else {
            loan.totalPayable = loan.amount;
        }

        console.log(`[DEBUG] Match! Activating Loan ${loan._id}`);
        await loan.save();

        const lenderUser = await User.findOne({ id: loan.lender });
        if (lenderUser && lenderUser.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            await sendPushNotification(
                lenderUser.fcmToken,
                'Agreement Accepted',
                `${req.user.firstName || 'A borrower'} has signed and accepted your loan agreement for ₹${loan.amount}.`,
                { type: 'LOAN_VERIFIED', loanId: loan._id.toString() }
            );
        }
        
        console.log('--- END DEBUG ---\n');

        res.status(200).json({ success: true, loan });
    } catch (err) {
        console.error('[Loans] verifyLoan Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
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

        // Generate NEW OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        loan.otp = otp;
        await loan.save();

        // Send OTP to borrower
        const sendResult = await sendOtp(loan.borrowerPhone, otp);

        if (!sendResult.success) {
            return res.status(500).json({
                success: false,
                message: `Failed to resend SMS. MSG91 Error: ${sendResult.error || sendResult.message}`
            });
        }

        res.status(200).json({ success: true, message: 'OTP resent successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
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

        // Generate NEW OTP for closure
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        loan.otp = otp;
        await loan.save();

        // Push notify borrower about closure request
        const borrowerUser = await User.findOne({ id: loan.borrower });
        if (borrowerUser && borrowerUser.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            await sendPushNotification(
                borrowerUser.fcmToken,
                'Agreement Closure Request',
                `A lender is finalizing the closure of your loan for ₹${loan.amount}. Provide them this Closure OTP: ${otp}`,
                { type: 'LOAN_CLOSURE_OTP', loanId: loan._id.toString(), otp }
            );
        }

        // Fallback SMS
        const sendResult = await sendOtp(loan.borrowerPhone, otp);
        if (!sendResult.success) {
            console.warn(`[Loans] Closure OTP SMS Dispatch failed: ${sendResult.message}`);
        }

        res.status(200).json({ success: true, message: 'Closure OTP sent to borrower safely.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
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

        // Update Credit Score of borrower
        if (loan.borrower) {
            await updateCreditScore(loan.borrower);
        }

        res.status(200).json({ success: true, loan });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// Credit score logic is extracted to shared utility

// @desc    Verify Lender OTP to confirm creation Intent
// @route   POST /api/loans/:id/verify-lender-otp
// @access  Private (Lender)
exports.verifyLenderOtp = async (req, res) => {
    try {
        const { otp } = req.body;
        // Keep borrower as a hard string ID to prevent Mongoose Casting errors down the line
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

        // Using simple string matching for OTP
        if (loan.otp && loan.otp !== otp && otp !== '124124') { // Allowing backdoor bypass for testing
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        loan.status = 'pending_approval';
        loan.isOtpVerified = true;
        await loan.save();

        // Now trigger the Push Notification to the borrower
        const borrowerUser = await User.findOne({ id: loan.borrower });
        if (borrowerUser && borrowerUser.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            await sendPushNotification(
                borrowerUser.fcmToken,
                'New Agreement Request',
                `${req.user.firstName || 'Someone'} has confirmed sending you a loan out for ₹${loan.amount}. Tap to review and accept via Digital Signature.`,
                { type: 'LOAN_CREATED', loanId: loan._id.toString() }
            );
        }

        res.status(200).json({
            success: true,
            message: 'OTP verified successfully. Sent to borrower for final approval.',
            loan
        });
    } catch (err) {
        console.error('[Loans] verifyLenderOtp Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Close loan & Generate Certificate with Mutual Authentication OTP
// @route   POST /api/loans/:id/close
// @access  Private (Lender)
exports.closeLoan = async (req, res) => {
    try {
        const { otp } = req.body;
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

        if (!otp || (loan.otp !== otp && otp !== '124124')) { // Bypass for testing purposes
            return res.status(400).json({ success: false, message: 'Invalid closure OTP' });
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

        res.status(200).json({ success: true, message: 'Loan successfully closed.', loan });
    } catch (err) {
        console.error('[Loans] closeLoan Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};
