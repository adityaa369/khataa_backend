const Loan = require('../models/Loan');
const User = require('../models/User');
const CreditScore = require('../models/CreditScore');
const { sendOtp } = require('../utils/otpProvider');

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
            type
        } = req.body;

        // Sanitize phone: strip 91 or +91
        const borrowerPhone = borrower_phone.toString().replace(/^\+?91/, '');
        const borrowerName = borrower_name;
        const borrowerAadhar = borrower_aadhar;
        const borrowerAddress = borrower_address;
        const interestRate = interest_rate;
        const durationMonths = duration_months;
        const loanType = type || 'personal';

        if (borrowerPhone === req.user.phone) {
            return res.status(400).json({
                success: false,
                message: 'You cannot give a loan to yourself'
            });
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

        // Generate OTP for loan agreement (sent to borrower)
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
            loanType,
            otp,
            status: 'pending_otp'
        });

        // Send OTP to borrower
        console.log(`[Loans] Sending Agreement OTP ${otp} to borrower ${borrowerPhone}...`);
        await sendOtp(borrowerPhone, otp);

        res.status(201).json({
            success: true,
            message: 'Loan agreement created. OTP sent to borrower.',
            loan,
            otp // TODO: Remove this in production!
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
        res.status(200).json({ success: true, loans });
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
        res.status(200).json({ success: true, loans });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Verify loan agreement via OTP
// @route   POST /api/loans/:id/verify
// @access  Private (Borrower)
exports.verifyLoan = async (req, res) => {
    try {
        const { otp } = req.body;
        console.log('\n--- LOAN VERIFICATION DEBUG ---');
        console.log('Loan ID received:', req.params.id);
        console.log('OTP received:', otp);

        const currentUserPhone = req.user.phone.toString().replace(/^\+?91/, '');
        console.log('User attempting verify:', currentUserPhone);

        const loan = await Loan.findById(req.params.id);

        if (!loan) {
            console.error(`[Loans] Loan ${req.params.id} not found.`);
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        // Check if current user is involved in the loan
        const isLender = loan.lender.toString() === req.user.id.toString();
        const isBorrower = loan.borrowerPhone === currentUserPhone;

        // ALLOW Lender to verify (Lender-driven flow) OR Borrower (Self-verify flow)
        if (!isLender && !isBorrower) {
            console.error(`[Loans] SECURITY ALERT: User ${req.user.id} is neither Lender nor Borrower.`);
            return res.status(403).json({ success: false, message: 'Not authorized to verify this loan.' });
        }

        console.log(`[Loans] Verification allowed for User ${req.user.id} (Is Lender: ${isLender}, Is Borrower: ${isBorrower})`);

        // If the current user is the borrower, ensure their phone matches the loan's borrowerPhone
        // This check is crucial for borrower-initiated verification to prevent one borrower from verifying another's loan.
        // For lender-initiated verification, this check is bypassed as the lender is not the borrower.
        if (isBorrower && loan.borrowerPhone !== currentUserPhone) {
            console.error(`[Loans] PHONE MISMATCH: Loan intended for ${loan.borrowerPhone}, but ${currentUserPhone} is trying to verify.`);
            return res.status(403).json({ success: false, message: 'This loan was not issued to this phone number.' });
        }

        console.log(`[DEBUG] DB Stored OTP: "${loan.otp}"`);
        console.log(`[DEBUG] Received OTP: "${otp}"`);

        if (loan.otp?.toString().trim() !== otp?.toString().trim()) {
            console.error(`[DEBUG] OTP MISMATCH for loan ${loan._id}`);
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        loan.status = 'active';
        loan.isOtpVerified = true;
        loan.startDate = Date.now();
        loan.borrower = req.user.id; // Link the borrower's actual user ID

        console.log(`[DEBUG] Match! Activating Loan ${loan._id}`);
        await loan.save();
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
        await sendOtp(loan.borrowerPhone, otp);

        res.status(200).json({ success: true, message: 'OTP resent successfully' });
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

// Helper to update credit score
async function updateCreditScore(userId) {
    const loans = await Loan.find({ borrower: userId, status: { $in: ['active', 'completed'] } });

    if (loans.length === 0) return;

    let scorePoints = 0;
    loans.forEach(loan => {
        if (loan.status === 'completed') {
            scorePoints += 100;
        } else {
            scorePoints += (loan.progress * 50);
        }
    });

    // Simple algorithm: base 300 + points, max 900
    const newScore = Math.min(300 + Math.floor(scorePoints), 900);

    let status = 'Good';
    if (newScore < 500) status = 'Poor';
    else if (newScore < 700) status = 'Fair';
    else if (newScore < 800) status = 'Good';
    else status = 'Excellent';

    await CreditScore.findOneAndUpdate(
        { user: userId },
        {
            cibilScore: newScore,
            experianScore: newScore + 5,
            status,
            lastUpdated: Date.now()
        },
        { upsert: true }
    );
}
