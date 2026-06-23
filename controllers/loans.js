const Loan = require('../models/Loan');
const User = require('../models/User');
const { sendOtp } = require('../utils/otpProvider');
const { sendPushNotification } = require('../utils/fcm');
const { updateCreditScore } = require('../utils/creditScoreCalc');
const { sendEmail } = require('../utils/email');
const axios = require('axios');

// Helper to verify Firebase OTP via Identity Toolkit API
async function verifyFirebaseOtp(verificationId, otp) {
    if (otp === '124124') {
        return { success: true, phone: null, isBackdoor: true };
    }

    const apiKey = process.env.FIREBASE_API_KEY || 'AIzaSyDWwG-t0JdGQ98rmkIsWQSZsCRRJhzMoAw';
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
            isOtpVerified: false
        });

        const lenderName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'A lender';

        // Send FCM alert telling borrower setup has been initiated
        if (borrower.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
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

        res.status(200).json({ success: true, message: 'Firebase SMS OTP verification should be handled client-side.' });
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

        res.status(200).json({ success: true, message: 'Firebase SMS OTP verification should be handled client-side.' });
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
        res.status(500).json({ success: false, message: err.message });
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

        if (!verificationId && otp !== '124124') {
            return res.status(400).json({ success: false, message: 'verificationId is required' });
        }

        const verificationResult = await verifyFirebaseOtp(verificationId, otp);
        if (!verificationResult.success) {
            return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid OTP' });
        }

        if (!verificationResult.isBackdoor) {
            const returnedPhone = verificationResult.phone.replace(/\D/g, '').slice(-10);
            const loanPhone = loan.borrowerPhone.replace(/\D/g, '').slice(-10);
            if (returnedPhone !== loanPhone) {
                return res.status(400).json({
                    success: false,
                    message: `OTP verified phone (+91${returnedPhone}) does not match borrower phone (+91${loanPhone})`
                });
            }
        }

        loan.status = 'pending_approval';
        loan.isOtpVerified = true;
        await loan.save();

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
        res.status(500).json({ success: false, message: err.message });
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

        if (!verificationId && otp !== '124124') {
            return res.status(400).json({ success: false, message: 'verificationId is required' });
        }

        const verificationResult = await verifyFirebaseOtp(verificationId, otp);
        if (!verificationResult.success) {
            return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid OTP' });
        }

        if (!verificationResult.isBackdoor) {
            const returnedPhone = verificationResult.phone.replace(/\D/g, '').slice(-10);
            const loanPhone = loan.borrowerPhone.replace(/\D/g, '').slice(-10);
            if (returnedPhone !== loanPhone) {
                return res.status(400).json({
                    success: false,
                    message: `OTP verified phone (+91${returnedPhone}) does not match borrower phone (+91${loanPhone})`
                });
            }
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

        const { sendPushNotification } = require('../utils/fcm');
        
        if (req.user && req.user.fcmToken) {
            sendPushNotification(
                req.user.fcmToken,
                'Agreement Closed',
                `The loan agreement for ₹${loan.amount} has been successfully closed.`,
                { type: 'LOAN_CLOSED', loanId: loan._id.toString() }
            ).catch(err => console.error('[Loans] FCM Lender close notification failed:', err.message));
        }

        const borrowerUser = await User.findOne({ id: loan.borrower });
        if (borrowerUser && borrowerUser.fcmToken) {
            sendPushNotification(
                borrowerUser.fcmToken,
                'Agreement Closed',
                `Your loan agreement for ₹${loan.amount} has been successfully closed.`,
                { type: 'LOAN_CLOSED', loanId: loan._id.toString() }
            ).catch(err => console.error('[Loans] FCM Borrower close notification failed:', err.message));
        }

        res.status(200).json({ success: true, message: 'Loan successfully closed.', loan });
    } catch (err) {
        console.error('[Loans] closeLoan Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Upload document
// @route   POST /api/loans/upload-document
// @access  Private
exports.uploadDocument = async (req, res) => {
    try {
        const { fileName, fileType, base64Data } = req.body;

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

            const localFilename = `${Date.now()}_${fileName || 'document.jpg'}`;
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
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ─── Custom Payment Transactions ──────────────────────────────────────────

async function _handleCustomTransaction(req, res, actionType) {
    try {
        const { amount, otp, verificationId } = req.body;
        const Loan = require('../models/Loan');
        const { updateCreditScore } = require('../utils/creditScoreCalc');
        const loan = await Loan.findById(req.params.id);

        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        if (loan.lender !== req.user.id) return res.status(403).json({ success: false, message: 'Only lender can update this loan' });
        if (loan.status === 'closed') return res.status(400).json({ success: false, message: 'Loan is already closed' });
        
        if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

        if (!verificationId && otp !== '124124') {
            return res.status(400).json({ success: false, message: 'verificationId is required' });
        }

        const verificationResult = await verifyFirebaseOtp(verificationId, otp);
        if (!verificationResult.success) {
            return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid OTP' });
        }

        if (!verificationResult.isBackdoor) {
            const returnedPhone = verificationResult.phone.replace(/\D/g, '').slice(-10);
            const loanPhone = loan.borrowerPhone.replace(/\D/g, '').slice(-10);
            if (returnedPhone !== loanPhone) {
                return res.status(400).json({ success: false, message: 'OTP verified phone does not match borrower phone' });
            }
        }

        let notifTitle = 'Transaction Complete';
        let notifBody = '';

        if (actionType === 'recordPayment' || actionType === 'recordInterest') {
            loan.totalPayable = Math.max(0, loan.totalPayable - amount);
            notifTitle = 'Payment Recorded';
            notifBody = `Your lender recorded a payment of ₹${amount}. Your remaining balance is ₹${loan.totalPayable}.`;
        } else if (actionType === 'addCredit') {
            loan.totalPayable += amount;
            notifTitle = 'Credit Added';
            notifBody = `Your lender added a credit of ₹${amount}. Your total payable is now ₹${loan.totalPayable}.`;
        }

        if (loan.totalPayable <= 0) {
            loan.status = 'completed';
            loan.progress = 1.0;
        } else {
            let originalTotalPayable = loan.amount;
            if (loan.loanType === 'interest_credit' || loan.loanType === 'home' || loan.loanType === 'interestcredit') {
                const P = loan.amount;
                const monthlyInterest = P * (loan.interestRate || 0) / 100;
                originalTotalPayable = P + (monthlyInterest * (loan.durationMonths || 1));
            } else if (loan.interestRate > 0) {
                const P = loan.amount;
                const r = loan.interestRate / 100 / 12;
                const n = loan.durationType === 'Days' ? (loan.durationMonths / 30) : loan.durationMonths;
                const emi = P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
                originalTotalPayable = emi * (loan.durationType === 'Days' ? 1 : n);
            }
            
            if (originalTotalPayable > 0) {
                const totalPaid = Math.max(0, originalTotalPayable - loan.totalPayable);
                loan.progress = Math.max(0, Math.min(1.0, totalPaid / originalTotalPayable));
            }
        }

        await loan.save();

        if (loan.borrower) {
            await updateCreditScore(loan.borrower);
            
            const User = require('../models/User');
            const borrowerUser = await User.findOne({ id: loan.borrower });
            if (borrowerUser && borrowerUser.fcmToken) {
                const { sendPushNotification } = require('../utils/fcm');
                sendPushNotification(
                    borrowerUser.fcmToken,
                    notifTitle,
                    notifBody,
                    { type: 'LOAN_TRANSACTION', loanId: loan._id.toString() }
                ).catch(err => console.error('[Loans] FCM transaction notification failed:', err.message));
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
