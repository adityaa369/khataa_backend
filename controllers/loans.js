const Loan = require('../models/Loan');
const User = require('../models/User');
const { sendOtp } = require('../utils/otpProvider');
const { sendPushNotification } = require('../utils/fcm');
const { updateCreditScore } = require('../utils/creditScoreCalc');
const { sendEmail } = require('../utils/email');

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

        // Send OTP to borrower for consent verification by lender via Email
        const lenderName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'A lender';
        const emailSubject = `Verify Loan Agreement Setup OTP - Khatha`;
        const emailText = `Hello,\n\nA new loan agreement of ₹${amount} has been initiated with you by ${lenderName}.\nYour verification OTP code is: ${otp}\n\nPlease provide this OTP to your lender to set up the agreement.\n\nRegards,\nKhatha Team`;
        const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
          <h2 style="color: #4A90E2; text-align: center;">Khatha Agreement Verification</h2>
          <hr style="border: 0; border-top: 1px solid #e0e0e0;">
          <p>Hello,</p>
          <p>A new credit agreement has been initiated for you on <strong>Khatha</strong> by <strong>${lenderName}</strong>.</p>
          <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>Agreement Details:</strong></p>
            <p style="margin: 5px 0;">Lender Name: <strong>${lenderName}</strong></p>
            <p style="margin: 5px 0;">Amount: <strong style="color: #2ECC71;">₹${amount}</strong></p>
            <p style="margin: 5px 0;">Interest Rate: <strong>${interestRate}%</strong></p>
          </div>
          <p style="text-align: center; font-size: 16px; margin-top: 30px;">Your Verification OTP Code is:</p>
          <div style="text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #4A90E2; margin: 10px 0; padding: 10px; border: 1px dashed #4A90E2; display: inline-block; width: 100%;">
            ${otp}
          </div>
          <p style="color: #7f8c8d; font-size: 12px; margin-top: 30px; text-align: center;">This OTP is valid for this transaction. If you did not request this, please ignore this email.</p>
        </div>`;

        await sendEmail({ to: borrower.email, subject: emailSubject, text: emailText, html: emailHtml });

        // Send FCM alert telling borrower to check email for OTP
        if (borrower.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            await sendPushNotification(
                borrower.fcmToken,
                'Lender Setup Verification',
                `A credit agreement setup for ₹${amount} has been initiated. Please check your email (${borrower.email}) for the verification OTP.`,
                { type: 'LOAN_OTP', loanId: loan._id.toString(), otp }
            );
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

            if (loan.loanType === 'interest_credit' || loan.loanType === 'home' || loan.loanType === 'interestcredit') {
                const P = loan.amount;
                const monthlyInterest = P * (loan.interestRate || 0) / 100;
                loan.emiAmount = monthlyInterest;
                loan.totalPayable = P + (monthlyInterest * (loan.durationMonths || 1));
            } else if (loan.interestRate > 0) {
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

        const { sendPushNotification } = require('../utils/fcm');

        const lenderUser = await User.findOne({ id: loan.lender });
        if (lenderUser && lenderUser.fcmToken) {
            await sendPushNotification(
                lenderUser.fcmToken,
                'Agreement Accepted',
                `${req.user.firstName || 'A borrower'} has signed and accepted your loan agreement for ₹${loan.amount}.`,
                { type: 'LOAN_VERIFIED', loanId: loan._id.toString() }
            );
        }

        if (req.user && req.user.fcmToken) {
            await sendPushNotification(
                req.user.fcmToken,
                'Agreement Activated',
                `Your loan agreement for ₹${loan.amount} is now active and on track.`,
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

        // Get borrower email
        const borrower = await User.findOne({ phone: loan.borrowerPhone });
        if (!borrower || !borrower.email) {
            return res.status(400).json({
                success: false,
                message: 'Borrower email not found. Cannot resend OTP via email.'
            });
        }

        const lenderUser = await User.findOne({ id: loan.lender });
        const lenderName = lenderUser ? `${lenderUser.firstName || ''} ${lenderUser.lastName || ''}`.trim() : 'A lender';

        const emailSubject = `Verify Loan Agreement Setup OTP - Khatha (Resend)`;
        const emailText = `Hello,\n\nA new loan agreement of ₹${loan.amount} has been initiated with you by ${lenderName}.\nYour verification OTP code is: ${otp}\n\nPlease provide this OTP to your lender to set up the agreement.\n\nRegards,\nKhatha Team`;
        const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
          <h2 style="color: #4A90E2; text-align: center;">Khatha Agreement Verification</h2>
          <hr style="border: 0; border-top: 1px solid #e0e0e0;">
          <p>Hello,</p>
          <p>A new credit agreement has been initiated for you on <strong>Khatha</strong> by <strong>${lenderName}</strong>.</p>
          <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>Agreement Details:</strong></p>
            <p style="margin: 5px 0;">Lender Name: <strong>${lenderName}</strong></p>
            <p style="margin: 5px 0;">Amount: <strong style="color: #2ECC71;">₹${loan.amount}</strong></p>
            <p style="margin: 5px 0;">Interest Rate: <strong>${loan.interestRate}%</strong></p>
          </div>
          <p style="text-align: center; font-size: 16px; margin-top: 30px;">Your Verification OTP Code is:</p>
          <div style="text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #4A90E2; margin: 10px 0; padding: 10px; border: 1px dashed #4A90E2; display: inline-block; width: 100%;">
            ${otp}
          </div>
          <p style="color: #7f8c8d; font-size: 12px; margin-top: 30px; text-align: center;">This OTP is valid for this transaction. If you did not request this, please ignore this email.</p>
        </div>`;

        await sendEmail({ to: borrower.email, subject: emailSubject, text: emailText, html: emailHtml });

        // Trigger FCM push notification alert to borrower as well
        if (borrower.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            await sendPushNotification(
                borrower.fcmToken,
                'Lender Setup Verification',
                `A credit agreement setup for ₹${loan.amount} has been initiated. Please check your email (${borrower.email}) for the verification OTP.`,
                { type: 'LOAN_OTP', loanId: loan._id.toString(), otp }
            );
        }

        res.status(200).json({ success: true, message: 'OTP resent successfully via email' });
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

        const borrowerUser = await User.findOne({ id: loan.borrower });
        if (!borrowerUser || !borrowerUser.email) {
            return res.status(400).json({
                success: false,
                message: 'Borrower email not found. Cannot send closure OTP via email.'
            });
        }

        const lenderUser = await User.findOne({ id: loan.lender });
        const lenderName = lenderUser ? `${lenderUser.firstName || ''} ${lenderUser.lastName || ''}`.trim() : 'A lender';

        const emailSubject = `Verify Loan Agreement Closure OTP - Khatha`;
        const emailText = `Hello,\n\nA request to close/complete your credit agreement of ₹${loan.amount} has been initiated by ${lenderName}.\nYour closure verification OTP code is: ${otp}\n\nPlease provide this OTP to your lender to finalize and close the agreement.\n\nRegards,\nKhatha Team`;
        const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
          <h2 style="color: #E74C3C; text-align: center;">Khatha Agreement Closure</h2>
          <hr style="border: 0; border-top: 1px solid #e0e0e0;">
          <p>Hello,</p>
          <p>A request to close/complete your credit agreement has been initiated on <strong>Khatha</strong> by <strong>${lenderName}</strong>.</p>
          <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>Agreement Details:</strong></p>
            <p style="margin: 5px 0;">Lender Name: <strong>${lenderName}</strong></p>
            <p style="margin: 5px 0;">Amount: <strong style="color: #2ECC71;">₹${loan.amount}</strong></p>
          </div>
          <p style="text-align: center; font-size: 16px; margin-top: 30px;">Your Verification OTP Code is:</p>
          <div style="text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #E74C3C; margin: 10px 0; padding: 10px; border: 1px dashed #E74C3C; display: inline-block; width: 100%;">
            ${otp}
          </div>
          <p style="color: #7f8c8d; font-size: 12px; margin-top: 30px; text-align: center;">Please share this OTP with the lender to finalize and close the agreement. If you did not request this, please ignore this email.</p>
        </div>`;

        await sendEmail({ to: borrowerUser.email, subject: emailSubject, text: emailText, html: emailHtml });

        // Push notify borrower about closure request
        if (borrowerUser.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            await sendPushNotification(
                borrowerUser.fcmToken,
                'Agreement Closure Request',
                `A closure request for your agreement of ₹${loan.amount} has been initiated. Please check your email (${borrowerUser.email}) for the verification OTP.`,
                { type: 'LOAN_CLOSURE_OTP', loanId: loan._id.toString(), otp }
            );
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

        try {
            const { sendPushNotification } = require('../utils/fcm');
            
            if (req.user && req.user.fcmToken) {
                await sendPushNotification(
                    req.user.fcmToken,
                    'Agreement Closed',
                    `The loan agreement for ₹${loan.amount} has been successfully closed.`,
                    { type: 'LOAN_CLOSED', loanId: loan._id.toString() }
                );
            }

            const borrowerUser = await User.findOne({ id: loan.borrower });
            if (borrowerUser && borrowerUser.fcmToken) {
                await sendPushNotification(
                    borrowerUser.fcmToken,
                    'Agreement Closed',
                    `Your loan agreement for ₹${loan.amount} has been successfully closed.`,
                    { type: 'LOAN_CLOSED', loanId: loan._id.toString() }
                );
            }
        } catch (fcmErr) {
            console.error('[Loans] FCM closure notification failed:', fcmErr.message);
        }

        res.status(200).json({ success: true, message: 'Loan successfully closed.', loan });
    } catch (err) {
        console.error('[Loans] closeLoan Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};
