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
            documentIds,
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


        // Verify ownership of uploaded documents in Firebase Storage
        if (documentIds && documentIds.length > 0) {
            const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
            const { getStorage } = require('firebase-admin/storage');
            const bucket = getStorage().bucket(bucketName);
            
            for (const docId of documentIds) {
                if (docId.startsWith('documents/')) {
                    const file = bucket.file(docId);
                    const [exists] = await file.exists();
                    if (!exists) {
                        return res.status(400).json({ success: false, message: `Document ${docId} does not exist` });
                    }
                    const [metadata] = await file.getMetadata();
                    if (!metadata.metadata || metadata.metadata.uploadedBy !== req.user.id) {
                        return res.status(403).json({ success: false, message: `You do not have permission to attach document ${docId}` });
                    }
                }
            }
        }

        const normalizedDocumentIds = Array.isArray(documentIds)
            ? documentIds.filter(Boolean).map(String)
            : (documentId ? String(documentId).split(',').map(s => s.trim()).filter(Boolean) : []);
        const effectiveDocumentId = documentId || (normalizedDocumentIds.length > 0 ? normalizedDocumentIds.join(',') : undefined);

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
            documentId: effectiveDocumentId,
            documentIds: normalizedDocumentIds
        });
        
        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        const lenderName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'A lender';

        // Send FCM alert telling borrower setup has been initiated
        const EventDispatcher = require('../utils/EventDispatcher');
        const NotificationEvents = require('../utils/NotificationEvents');
        
        EventDispatcher.dispatch({
            eventType: NotificationEvents.AGREEMENT_READY,
            aggregateType: 'LOAN',
            aggregateId: loan._id.toString(),
            recipientUserId: borrower._id,
            payload: {
                title: 'Lender Setup Verification',
                body: `A credit agreement setup for ₹${amount} has been initiated by ${lenderName}.`,
                type: 'LOAN_INIT_OTP',
                loanId: loan._id.toString()
            }
        }).catch(err => console.error('[EventDispatcher] Failed:', err.message));

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
        const FinancialLedgerService = require('../services/FinancialLedgerService');
        for (const loan of loans) {
            // Retroactive fix for fixed-interest loans without upfront interest
            if (['interest_credit', 'business_credit'].includes(loan.loanType)) {
                let modified = false;
                
                // Deduplicate upfront interest if race condition caused multiple inserts
                if (loan.transactions) {
                    const upfrontTxns = loan.transactions.filter(t => t.type === 'interest_accrued' && t.note && t.note.includes('Upfront'));
                    if (upfrontTxns.length > 1) {
                        const firstUpfrontId = upfrontTxns[0]._id;
                        loan.transactions = loan.transactions.filter(t => 
                            !(t.type === 'interest_accrued' && t.note && t.note.includes('Upfront') && t._id.toString() !== firstUpfrontId.toString())
                        );
                        modified = true;
                    }
                }

                const hasUpfront = loan.transactions && loan.transactions.some(t => t.type === 'interest_accrued' && t.note && t.note.includes('Upfront'));
                if (!hasUpfront && loan.status !== 'pending_approval' && loan.status !== 'pending_otp' && loan.status !== 'rejected' && loan.principalOutstandingPaise > 0) {
                    await FinancialLedgerService.accrueInterest(loan);
                    modified = true;
                }

                if (modified) await loan.save();
            }
            
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
        const loan = await Loan.findById(req.params.id)
            .populate({ path: 'lender', model: 'User', localField: 'lender', foreignField: 'id', select: 'firstName lastName phone' })
            .populate({ path: 'borrower', model: 'User', localField: 'borrower', foreignField: 'id', select: 'firstName lastName phone' });
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        const isLender = loan.lender && (loan.lender.id === req.user.id || loan.lender === req.user.id);
        const isBorrower = (loan.borrower && (loan.borrower.id === req.user.id || loan.borrower === req.user.id)) || 
                           (loan.borrowerPhone === req.user.phone.toString().replace(/^\+?91/, ''));
                           
        if (!isLender && !isBorrower) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this loan' });
        }

        // Retroactive fix for fixed-interest loans without upfront interest
        if (['interest_credit', 'business_credit'].includes(loan.loanType)) {
            let modified = false;
            
            // Deduplicate upfront interest if race condition caused multiple inserts
            if (loan.transactions) {
                const upfrontTxns = loan.transactions.filter(t => t.type === 'interest_accrued' && t.note && t.note.includes('Upfront'));
                if (upfrontTxns.length > 1) {
                    const firstUpfrontId = upfrontTxns[0]._id;
                    loan.transactions = loan.transactions.filter(t => 
                        !(t.type === 'interest_accrued' && t.note && t.note.includes('Upfront') && t._id.toString() !== firstUpfrontId.toString())
                    );
                    modified = true;
                }
            }

            const hasUpfront = loan.transactions && loan.transactions.some(t => t.type === 'interest_accrued' && t.note && t.note.includes('Upfront'));
            if (!hasUpfront && loan.status !== 'pending_approval' && loan.status !== 'pending_otp' && loan.status !== 'rejected' && loan.principalOutstandingPaise > 0) {
                const FinancialLedgerService = require('../services/FinancialLedgerService');
                await FinancialLedgerService.accrueInterest(loan);
                modified = true;
            }

            if (modified) await loan.save();
        }

        res.status(200).json({ success: true, loan });
    } catch (err) {
        console.error('[Loans] getLoanById Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
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
            $or: [
                { borrowerPhone: phone },
                { borrower: req.user.id }
            ],
            lender: { $ne: req.user.id }, // Explicitly exclude loans where I am the lender
            status: { $ne: 'pending_otp' }
        });

        // Populate lender details manually to avoid changing the Mongoose schema
        const loansWithLender = [];
        const FinancialLedgerService = require('../services/FinancialLedgerService');
        for (const loan of loans) {
            // Retroactive fix for fixed-interest loans without upfront interest
            if (['interest_credit', 'business_credit'].includes(loan.loanType)) {
                let modified = false;
                
                // Deduplicate upfront interest if race condition caused multiple inserts
                if (loan.transactions) {
                    const upfrontTxns = loan.transactions.filter(t => t.type === 'interest_accrued' && t.note && t.note.includes('Upfront'));
                    if (upfrontTxns.length > 1) {
                        const firstUpfrontId = upfrontTxns[0]._id;
                        loan.transactions = loan.transactions.filter(t => 
                            !(t.type === 'interest_accrued' && t.note && t.note.includes('Upfront') && t._id.toString() !== firstUpfrontId.toString())
                        );
                        modified = true;
                    }
                }

                const hasUpfront = loan.transactions && loan.transactions.some(t => t.type === 'interest_accrued' && t.note && t.note.includes('Upfront'));
                if (!hasUpfront && loan.status !== 'pending_approval' && loan.status !== 'pending_otp' && loan.status !== 'rejected' && loan.principalOutstandingPaise > 0) {
                    await FinancialLedgerService.accrueInterest(loan);
                    modified = true;
                }

                if (modified) await loan.save();
            }

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

        const isBorrower = String(loan.borrowerPhone).replace(/\D/g, '').slice(-10) === String(req.user.phone).replace(/\D/g, '').slice(-10);
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

        await invalidateLoanCache(loan.lender, loan.borrower);
        await cacheInvalidate(`loans:given:${loan.lender}`, `loans:taken:${loan.borrower}`);

        const EventDispatcher = require('../utils/EventDispatcher');
        const NotificationEvents = require('../utils/NotificationEvents');

        const lenderUser = await User.findOne({ id: loan.lender });
        if (lenderUser) {
            EventDispatcher.dispatch({
                eventType: NotificationEvents.AGREEMENT_ACCEPTED,
                aggregateType: 'LOAN',
                aggregateId: loan._id.toString(),
                recipientUserId: lenderUser._id,
                payload: {
                    title: 'Agreement Accepted',
                    body: `${req.user.firstName || 'A borrower'} has signed and accepted your loan agreement for ₹${loan.amount}.`,
                    type: 'LOAN_VERIFIED',
                    loanId: loan._id.toString()
                }
            }).catch(err => console.error('[EventDispatcher] Failed:', err.message));
        }

        if (req.user) {
            EventDispatcher.dispatch({
                eventType: NotificationEvents.LOAN_ACTIVATED,
                aggregateType: 'LOAN',
                aggregateId: loan._id.toString(),
                recipientUserId: req.user._id,
                channels: ['PUSH', 'IN_APP', 'EMAIL'], // Request email delivery
                payload: {
                    title: 'Agreement Activated',
                    body: `Your loan agreement for ₹${loan.amount} is now active and on track.`,
                    type: 'LOAN_VERIFIED',
                    loanId: loan._id.toString(),
                    // Template data for worker
                    amount: loan.amount,
                    loanType: loan.loanType,
                    durationMonths: loan.durationMonths,
                    interestRate: loan.interestRate,
                    startDate: loan.startDate,
                    lenderName: lenderUser ? `${lenderUser.firstName || ''} ${lenderUser.lastName || ''}`.trim() : 'Your Lender',
                    borrowerName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.phone
                }
            }).catch(err => console.error('[EventDispatcher] Failed:', err.message));
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
            
            const EventDispatcher = require('../utils/EventDispatcher');
            const NotificationEvents = require('../utils/NotificationEvents');
            
            const User = require('../models/User');
            const borrowerUser = await User.findOne({ id: loan.borrower });
            if (borrowerUser) {
                EventDispatcher.dispatch({
                    eventType: (progress >= 1.0) ? NotificationEvents.LOAN_COMPLETED : NotificationEvents.PAYMENT_RECEIVED,
                    aggregateType: 'LOAN',
                    aggregateId: loan._id.toString(),
                    recipientUserId: borrowerUser._id,
                    payload: {
                        title: (progress >= 1.0) ? 'Loan Completed' : 'Loan Progress Updated',
                        body: `Your lender has updated the repayment progress for your loan of ₹${loan.amount}.`,
                        type: 'LOAN_PROGRESS_UPDATED',
                        loanId: loan._id.toString()
                    }
                }).catch(err => console.error('[EventDispatcher] Failed:', err.message));
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

        const EventDispatcher = require('../utils/EventDispatcher');
        const NotificationEvents = require('../utils/NotificationEvents');

        const borrowerUser = await User.findOne({ id: loan.borrower });
        if (borrowerUser) {
            EventDispatcher.dispatch({
                eventType: NotificationEvents.AGREEMENT_READY,
                aggregateType: 'LOAN',
                aggregateId: loan._id.toString(),
                recipientUserId: borrowerUser._id,
                payload: {
                    title: 'New Agreement Request',
                    body: `${req.user.firstName || 'Someone'} has confirmed sending you a loan out for ₹${loan.amount}. Tap to review and accept via Digital Signature.`,
                    type: 'LOAN_CREATED',
                    loanId: loan._id.toString()
                }
            }).catch(err => console.error('[EventDispatcher] Failed:', err.message));
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
        const { invalidateLoanCache } = require('../middleware/cache');

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

        const EventDispatcher = require('../utils/EventDispatcher');
        const NotificationEvents = require('../utils/NotificationEvents');
        const { withTransaction } = require('../utils/dbTransaction');

        // === ATOMIC BOUNDARY: close + outbox ===
        await withTransaction(async (session) => {
            const sessionLoan = await Loan.findById(loan._id).session(session);
            sessionLoan.status = 'closed';
            sessionLoan.progress = 1.0;
            await sessionLoan.save({ session });

            const sessionIntent = await TransactionIntent.findById(intent._id).session(session);
            sessionIntent.status = 'COMMITTED';
            await sessionIntent.save({ session });

            // Dispatch to both lender and borrower (if exists)
            const dispatchPromises = [
                EventDispatcher.dispatch({
                    eventType: NotificationEvents.LOAN_CLOSED,
                    aggregateType: 'LOAN',
                    aggregateId: sessionLoan._id.toString(),
                    recipientUserId: req.user._id,
                    payload: { title: 'Loan Closed', body: `Your loan of ₹${loan.amount} has been closed.`, type: 'LOAN_CLOSED', loanId: sessionLoan._id.toString() },
                    idempotencyKey: `${intentId}_LENDER`,
                    session
                })
            ];

            if (sessionLoan.borrower) {
                const BorrowerUser = require('../models/User');
                const borrowerUser = await BorrowerUser.findOne({ id: sessionLoan.borrower }).session(session);
                if (borrowerUser) {
                    dispatchPromises.push(EventDispatcher.dispatch({
                        eventType: NotificationEvents.LOAN_CLOSED,
                        aggregateType: 'LOAN',
                        aggregateId: sessionLoan._id.toString(),
                        recipientUserId: borrowerUser._id,
                        payload: { title: 'Loan Closed', body: `Your loan of ₹${loan.amount} has been closed.`, type: 'LOAN_CLOSED', loanId: sessionLoan._id.toString() },
                        idempotencyKey: `${intentId}_BORROWER`,
                        session
                    }));
                }
            }
            await Promise.all(dispatchPromises);

            loan.status = 'closed';
            loan.progress = 1.0;
        }); // === END ATOMIC BOUNDARY ===

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
        const EventDispatcher = require('../utils/EventDispatcher');
        const NotificationEvents = require('../utils/NotificationEvents');
        const { withTransaction } = require('../utils/dbTransaction');

        let savedLoan;
        let notifTitle = 'Transaction Complete', notifBody = '';

        // === ATOMIC BOUNDARY: loan mutation + outbox insert in one session ===
        await withTransaction(async (session) => {
            // Re-fetch inside the session for clean session-bound document
            const sessionLoan = await Loan.findById(loan._id).session(session);

            if (actionType === 'recordPayment' || actionType === 'recordInterest') {
                const pType = actionType === 'recordInterest' ? 'interest' : 'principal';
                await FinancialLedgerService.recordPayment(sessionLoan, pa, intentId, req.user.id, new Date(), pType);
                notifTitle = 'Payment Recorded';
                notifBody = `Your lender recorded a payment of Rs.${pa / 100}. Remaining: Rs.${sessionLoan.totalPayablePaise / 100}.`;
            } else if (actionType === 'addCredit') {
                await FinancialLedgerService.addCredit(sessionLoan, pa, intentId, req.user.id);
                notifTitle = 'Credit Added';
                notifBody = `Your lender added Rs.${pa / 100}. Total payable: Rs.${sessionLoan.totalPayablePaise / 100}.`;
            }

            await sessionLoan.save({ session });
            savedLoan = sessionLoan;

            // Dispatch outbox inside the same session — atomically
            if (sessionLoan.borrower) {
                const BorrowerUser = require('../models/User');
                const borrowerUser = await BorrowerUser.findOne({ id: sessionLoan.borrower }).session(session);
                if (borrowerUser) {
                    let eventType = NotificationEvents.PAYMENT_RECEIVED;
                    if (actionType === 'addCredit') eventType = NotificationEvents.LOAN_RECEIVED;

                    await EventDispatcher.dispatch({
                        eventType,
                        aggregateType: 'LOAN',
                        aggregateId: sessionLoan._id.toString(),
                        recipientUserId: borrowerUser._id,
                        payload: {
                            title: notifTitle,
                            body: notifBody,
                            type: 'LOAN_TRANSACTION',
                            loanId: sessionLoan._id.toString()
                        },
                        idempotencyKey: intentId,
                        session
                    });
                }
            }
        }); // === END ATOMIC BOUNDARY ===

        const { invalidateLoanCache } = require('../middleware/cache');
        await invalidateLoanCache(loan.lender, loan.borrower);

        if (loan.borrower) {
            const { updateCreditScore } = require('../utils/creditScoreCalc');
            await updateCreditScore(loan.borrower);
        }

        res.status(200).json({ success: true, loan: savedLoan || loan });
    } catch (err) {
        console.error('[Loans] customTransaction Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
}
exports.recordPayment = (req, res) => _handleCustomTransaction(req, res, 'recordPayment');
exports.addCredit = (req, res) => _handleCustomTransaction(req, res, 'addCredit');
exports.recordInterest = (req, res) => _handleCustomTransaction(req, res, 'recordInterest');



// @desc    Get portfolio summary for insights
// @route   GET /api/loans/portfolio-summary
// @access  Private
exports.getPortfolioSummary = async (req, res) => {
    try {
        const userId = req.user.id;
        const ACTIVE_STATUSES = ['active', 'completed', 'defaulted', 'closed'];

        // ── LENDER stats (loans I gave out) ──────────────────────────────────
        const givenLoans = await Loan.find({ lender: userId });

        let lenderStats = {
            loanCount: 0,
            activeLoanCount: 0,
            closedLoanCount: 0,
            defaultedLoanCount: 0,
            totalLentPaise: 0,
            totalCollectedPaise: 0,
            outstandingPaise: 0,
            collectionRatePct: 0,
            monthlyCollections: [],
        };

        for (const loan of givenLoans) {
            if (!ACTIVE_STATUSES.includes(loan.status)) continue;
            lenderStats.loanCount++;
            if (loan.status === 'active')    lenderStats.activeLoanCount++;
            if (loan.status === 'closed')    lenderStats.closedLoanCount++;
            if (loan.status === 'defaulted') lenderStats.defaultedLoanCount++;

            const principal = loan.amountPaise || (loan.amount * 100) || 0;
            lenderStats.totalLentPaise += principal;

            const paid = loan.paidAmountPaise || (loan.paidAmount * 100) || 0;
            lenderStats.totalCollectedPaise += paid;

            let out = loan.principalOutstandingPaise;
            if (out == null) out = principal - paid;
            lenderStats.outstandingPaise += Math.max(0, out);
        }

        if (lenderStats.totalLentPaise > 0) {
            lenderStats.collectionRatePct = Math.round(
                (lenderStats.totalCollectedPaise / lenderStats.totalLentPaise) * 100
            );
        }

        // Monthly collections for the last 6 months (lender only)
        const now = new Date();
        const monthlyMap = {};
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
            monthlyMap[key] = { month: d.toLocaleString('en-IN', { month: 'short' }), amountPaise: 0 };
        }
        const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
        for (const loan of givenLoans) {
            if (!loan.transactions) continue;
            for (const p of loan.transactions) {
                if (p.type === 'payment' || p.type === 'PAYMENT' || p.type === 'interest_payment' || p.type === 'credit') {
                    const pDate = new Date(p.recordedAt || p.effectiveAt || p.createdAt || p.date);
                    if (pDate && pDate >= sixMonthsAgo && !isNaN(pDate.getTime())) {
                        const key = pDate.getFullYear() + '-' + String(pDate.getMonth() + 1).padStart(2, '0');
                        if (monthlyMap[key]) {
                            const amt = p.amountPaise != null ? p.amountPaise : (p.amount ? p.amount * 100 : 0);
                            monthlyMap[key].amountPaise += amt;
                        }
                    }
                }
            }
        }
        lenderStats.monthlyCollections = Object.values(monthlyMap);

        // ── BORROWER stats (loans I took) ─────────────────────────────────────
        const takenLoans = await Loan.find({ borrower: userId });

        let borrowerStats = {
            loanCount: 0,
            activeLoanCount: 0,
            closedLoanCount: 0,
            totalBorrowedPaise: 0,
            totalRepaidPaise: 0,
            outstandingPaise: 0,
            repaymentRatePct: 0,
        };

        for (const loan of takenLoans) {
            if (!ACTIVE_STATUSES.includes(loan.status)) continue;
            borrowerStats.loanCount++;
            if (loan.status === 'active') borrowerStats.activeLoanCount++;
            if (loan.status === 'closed') borrowerStats.closedLoanCount++;

            const principal = loan.amountPaise || (loan.amount * 100) || 0;
            borrowerStats.totalBorrowedPaise += principal;

            const paid = loan.paidAmountPaise || (loan.paidAmount * 100) || 0;
            borrowerStats.totalRepaidPaise += paid;

            let out = loan.principalOutstandingPaise;
            if (out == null) out = principal - paid;
            borrowerStats.outstandingPaise += Math.max(0, out);
        }

        if (borrowerStats.totalBorrowedPaise > 0) {
            borrowerStats.repaymentRatePct = Math.round(
                (borrowerStats.totalRepaidPaise / borrowerStats.totalBorrowedPaise) * 100
            );
        }

        res.status(200).json({
            success: true,
            data: {
                // Legacy fields kept for backward compatibility
                loanCount: lenderStats.loanCount,
                activeLoanCount: lenderStats.activeLoanCount,
                totalLentPaise: lenderStats.totalLentPaise,
                totalCollectedPaise: lenderStats.totalCollectedPaise,
                outstandingPaise: lenderStats.outstandingPaise,
                // New structured sections - never mixed
                lenderStats,
                borrowerStats,
            }
        });
    } catch (err) {
        console.error('[Loans] getPortfolioSummary Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

const { generateRepaymentTimeline } = require('../utils/repaymentSchedule');

exports.getRepaymentTimeline = async (req, res) => {
    try {
        const loan = await Loan.findById(req.params.id);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        const isLender = loan.lender && (loan.lender.toString() === req.user.id);
        const isBorrower = loan.borrower && (loan.borrower.toString() === req.user.id);
                           
        if (!isLender && !isBorrower) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this loan' });
        }

        const timeline = generateRepaymentTimeline(loan);
        
        res.status(200).json({ success: true, ...timeline });
    } catch (err) {
        console.error('[Loans] getRepaymentTimeline Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getInterestSchedule = async (req, res) => {
    try {
        const loan = await Loan.findById(req.params.id);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        const isLender = loan.lender && (loan.lender.toString() === req.user.id);
        const isBorrower = loan.borrower && (loan.borrower.toString() === req.user.id);
                           
        if (!isLender && !isBorrower) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this loan' });
        }

        const { generateInterestSchedule } = require('../utils/repaymentSchedule');
        const schedule = generateInterestSchedule(loan);
        
        res.status(200).json({ success: true, ...schedule });
    } catch (err) {
        console.error('[Loans] getInterestSchedule Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};


// @desc    Delete document (cleanup orphaned uploads)
// @route   POST /api/loans/delete-document
// @access  Private
exports.deleteDocument = async (req, res) => {
    try {
        const { documentId } = req.body;
        if (!documentId) return res.status(400).json({ success: false, message: 'Missing documentId' });

        if (documentId.startsWith('documents/')) {
            const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
            const { getStorage } = require('firebase-admin/storage');
            const bucket = getStorage().bucket(bucketName);
            const file = bucket.file(documentId);
            
            const [exists] = await file.exists();
            if (exists) {
                const [metadata] = await file.getMetadata();
                if (metadata.metadata && metadata.metadata.uploadedBy === req.user.id) {
                    await file.delete();
                    console.log(`[Cleanup] Deleted orphaned document ${documentId}`);
                    return res.status(200).json({ success: true, message: 'Document deleted' });
                } else {
                    console.warn(`[Security] User ${req.user.id} attempted to delete document ${documentId} owned by another user`);
                    return res.status(403).json({ success: false, message: 'Unauthorized' });
                }
            } else {
                return res.status(404).json({ success: false, message: 'Document not found' });
            }
        } else {
            return res.status(400).json({ success: false, message: 'Invalid documentId format' });
        }
    } catch (err) {
        console.error('[Cleanup] Error deleting document:', err.message);
        return res.status(500).json({ success: false, message: 'Server error during cleanup' });
    }
};


exports.downloadNoc = async (req, res) => {
    try {
        const PDFDocument = require('pdfkit');
        const Loan = require('../models/Loan');
        const User = require('../models/User');
        const FinancialLedgerService = require('../services/FinancialLedgerService');

        const loan = await Loan.findById(req.params.id);
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        const isLender = loan.lender && (loan.lender.toString() === req.user.id);
        const isBorrower = loan.borrower && (loan.borrower.toString() === req.user.id);
        if (!isLender && !isBorrower) {
            return res.status(403).json({ success: false, message: 'Not authorized to download this NOC' });
        }

        FinancialLedgerService.deriveBalances(loan);

        const totalOutstanding = (loan.principalOutstandingPaise || 0) + (loan.interestOutstandingPaise || 0) + (loan.feesOutstandingPaise || 0);
        const isSettled = loan.status === 'completed' || loan.status === 'closed' || totalOutstanding <= 0;

        if (!isSettled) {
            return res.status(400).json({ success: false, message: 'Credit is not fully settled yet. Outstanding dues remain.' });
        }

        if (totalOutstanding <= 0 && loan.status !== 'completed' && loan.status !== 'closed') {
            loan.status = 'completed';
            loan.progress = 1.0;
            await loan.save();
        }

        // Authoritative amounts (in Rupees)
        const principalRupees = loan.amountPaise ? (loan.amountPaise / 100) : (loan.amount || 0);
        const totalPaidRupees = loan.paidAmountPaise ? (loan.paidAmountPaise / 100) : (loan.paidAmount || 0);

        let totalInterestRupees = 0;
        const allTransactions = loan.transactions || [];
        const interestTxns = allTransactions.filter(t => t.type === 'interest_accrued');
        if (interestTxns.length > 0) {
            const totalInterestPaise = interestTxns.reduce((sum, t) => sum + (t.amountPaise || (t.amount ? t.amount * 100 : 0)), 0);
            totalInterestRupees = totalInterestPaise / 100;
        } else if (totalPaidRupees > principalRupees) {
            totalInterestRupees = totalPaidRupees - principalRupees;
        } else if (loan.interestRate > 0) {
            totalInterestRupees = (principalRupees * (loan.interestRate / 100) * (loan.durationMonths || 1));
        }

        const totalSettledValue = totalPaidRupees > 0 ? totalPaidRupees : (principalRupees + totalInterestRupees);

        // Fetch User profiles
        const lenderUser = await User.findOne({ id: loan.lender });
        const borrowerUser = loan.borrower ? await User.findOne({ id: loan.borrower }) : null;

        const lenderName = lenderUser ? `${lenderUser.firstName || ''} ${lenderUser.lastName || ''}`.trim() : 'Lender';
        const lenderPhone = lenderUser?.phone ? `+91 ${lenderUser.phone}` : 'N/A';
        const borrowerName = loan.borrowerName || (borrowerUser ? `${borrowerUser.firstName || ''} ${borrowerUser.lastName || ''}`.trim() : 'Borrower');
        const borrowerPhone = loan.borrowerPhone ? `+91 ${loan.borrowerPhone}` : (borrowerUser?.phone ? `+91 ${borrowerUser.phone}` : 'N/A');
        
        const rawAadhaar = loan.borrowerAadhar || (borrowerUser ? borrowerUser.aadhar : null);
        const hasAadhaar = rawAadhaar && rawAadhaar !== 'N/A' && rawAadhaar.trim().length > 0;
        const borrowerAadhaar = hasAadhaar ? rawAadhaar.trim() : null;

        const loanTypeStr = (loan.loanType || loan.type || 'Personal').toLowerCase();
        let displayType = 'Personal Credit';
        if (loanTypeStr.includes('interest')) displayType = 'Interest Credit';
        else if (loanTypeStr.includes('business')) displayType = 'Business Credit';
        else if (loanTypeStr.includes('hand')) displayType = 'Hand Credit';

        const startDateVal = loan.activatedAt || loan.startDate || loan.createdAt;
        const startDateStr = startDateVal && !isNaN(new Date(startDateVal).getTime())
            ? new Date(startDateVal).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
            : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

        const closeDateVal = loan.closedAt || loan.updatedAt;
        const closeDateStr = closeDateVal && !isNaN(new Date(closeDateVal).getTime())
            ? new Date(closeDateVal).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
            : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

        const issueDateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

        const doc = new PDFDocument({ margin: 40, size: 'A4' });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="NOC_' + loan._id + '.pdf"');

        doc.pipe(res);

        // --- Outer Border ---
        doc.rect(20, 20, 555, 802).lineWidth(1.5).stroke('#1E3A8A');
        doc.rect(23, 23, 549, 796).lineWidth(0.5).stroke('#93C5FD');

        // --- Header ---
        doc.fontSize(20).font('Helvetica-Bold').fillColor('#1E3A8A').text('NO DUES CERTIFICATE (NOC)', 40, 45, { align: 'center' });
        doc.fontSize(10).font('Helvetica').fillColor('#64748B').text('DEBT SETTLEMENT & CLEARANCE CERTIFICATION', { align: 'center' });
        doc.moveDown(0.5);

        // Line divider
        doc.strokeColor('#CBD5E1').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(0.8);

        // Meta Info
        const metaY = doc.y;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#334155').text('Certificate Ref: ', 40, metaY, { continued: true })
            .font('Helvetica').text(`NOC-${loan._id.toString().toUpperCase()}`);
        doc.fontSize(9).font('Helvetica-Bold').text('Date of Issue: ', 380, metaY, { continued: true })
            .font('Helvetica').text(issueDateStr);
        doc.moveDown(1.2);

        // Declaration
        doc.fontSize(10).font('Helvetica').fillColor('#1E293B').text(
            `This is an authoritative certification that the credit agreement detailed below, executed between the Lender and the Borrower, has been FULLY AND FINALLY REPAID. All principal, interest, and applicable fees have been completely settled with ZERO outstanding liability.`,
            40,
            doc.y,
            { align: 'justify', lineGap: 3 }
        );
        doc.moveDown(1);

        // --- Parties Box ---
        const box1Y = doc.y;
        doc.rect(40, box1Y, 515, 60).fillAndStroke('#F8FAFC', '#E2E8F0');
        doc.fillColor('#0F172A');

        doc.fontSize(9).font('Helvetica-Bold').text('LENDER DETAILS', 50, box1Y + 8);
        doc.font('Helvetica').fontSize(9).text(`Name: ${lenderName}`, 50, box1Y + 22);
        doc.text(`Phone: ${lenderPhone}`, 50, box1Y + 36);

        doc.fontSize(9).font('Helvetica-Bold').text('BORROWER DETAILS', 300, box1Y + 8);
        doc.font('Helvetica').fontSize(9).text(`Name: ${borrowerName}`, 300, box1Y + 22);
        const borrowerIdText = borrowerAadhaar
            ? `Phone: ${borrowerPhone}  |  Aadhaar: ${borrowerAadhaar}`
            : `Phone: ${borrowerPhone}  |  Status: Verified Borrower`;
        doc.text(borrowerIdText, 300, box1Y + 36);

        doc.y = box1Y + 70;
        doc.moveDown(0.5);

        // --- Credit Summary Box ---
        const box2Y = doc.y;
        doc.rect(40, box2Y, 515, 110).fillAndStroke('#F0FDF4', '#86EFAC');
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#166534').text('OFFICIAL CREDIT & SETTLEMENT BREAKDOWN', 50, box2Y + 10, { align: 'center' });
        doc.moveDown(0.5);

        const leftColX = 55;
        const rightColX = 310;
        let lineY = box2Y + 30;

        doc.fontSize(9).font('Helvetica-Bold').fillColor('#14532D');
        doc.text('Credit Type:', leftColX, lineY);
        doc.font('Helvetica').text(displayType, leftColX + 110, lineY);
        doc.font('Helvetica-Bold').text('Principal Disbursed:', rightColX, lineY);
        doc.font('Helvetica').text(`Rs. ${principalRupees.toLocaleString('en-IN')}`, rightColX + 115, lineY);

        lineY += 16;
        doc.font('Helvetica-Bold').text('Duration:', leftColX, lineY);
        doc.font('Helvetica').text(`${loan.durationMonths || 0} ${loan.durationType || 'Months'}`, leftColX + 110, lineY);
        doc.font('Helvetica-Bold').text('Interest Incurred:', rightColX, lineY);
        doc.font('Helvetica').text(`Rs. ${totalInterestRupees.toLocaleString('en-IN')}`, rightColX + 115, lineY);

        lineY += 16;
        doc.font('Helvetica-Bold').text('Disbursed Date:', leftColX, lineY);
        doc.font('Helvetica').text(startDateStr, leftColX + 110, lineY);
        doc.font('Helvetica-Bold').text('Total Settled Amount:', rightColX, lineY);
        doc.font('Helvetica').text(`Rs. ${totalSettledValue.toLocaleString('en-IN')}`, rightColX + 115, lineY);

        lineY += 16;
        doc.font('Helvetica-Bold').text('Settlement Date:', leftColX, lineY);
        doc.font('Helvetica').text(closeDateStr, leftColX + 110, lineY);
        doc.font('Helvetica-Bold').fillColor('#15803D').text('Outstanding Balance:', rightColX, lineY);
        doc.font('Helvetica-Bold').fillColor('#15803D').text('Rs. 0.00 (NIL / SETTLED)', rightColX + 115, lineY);

        doc.y = box2Y + 120;
        doc.moveDown(0.5);

        // --- Transaction Proof Table ---
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#1E3A8A').text('PAYMENT SETTLEMENT PROOF (AUDIT TRAIL)', 40, doc.y);
        doc.moveDown(0.4);

        const tableTop = doc.y;
        doc.rect(40, tableTop, 515, 20).fillAndStroke('#E2E8F0', '#CBD5E1');
        doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(8.5);
        doc.text('#', 48, tableTop + 5);
        doc.text('Date', 70, tableTop + 5);
        doc.text('Transaction Type / Note', 160, tableTop + 5);
        doc.text('Amount (INR)', 410, tableTop + 5);
        doc.text('Status', 485, tableTop + 5);

        const paymentTxns = allTransactions.filter(t => t.type === 'payment' || t.type === 'interest_payment');
        let currentY = tableTop + 20;

        if (paymentTxns.length === 0) {
            doc.rect(40, currentY, 515, 20).fillAndStroke('#FFFFFF', '#E2E8F0');
            doc.font('Helvetica').fontSize(8.5).fillColor('#64748B').text('Full settlement recorded via authorized closure.', 50, currentY + 5);
            currentY += 20;
        } else {
            paymentTxns.slice(0, 10).forEach((txn, index) => {
                const isEven = index % 2 === 0;
                doc.rect(40, currentY, 515, 18).fillAndStroke(isEven ? '#FFFFFF' : '#F8FAFC', '#E2E8F0');

                const tDate = new Date(txn.effectiveAt || txn.recordedAt || Date.now()).toLocaleDateString('en-IN');
                const tAmt = ((txn.amountPaise || (txn.amount ? txn.amount * 100 : 0)) / 100).toLocaleString('en-IN');
                let tDesc = txn.note || 'Payment Recorded';
                if (txn.principalAllocationPaise > 0 && txn.interestAllocationPaise > 0) {
                    tDesc = `Principal: Rs.${txn.principalAllocationPaise/100} + Interest: Rs.${txn.interestAllocationPaise/100}`;
                } else if (txn.principalAllocationPaise > 0) {
                    tDesc = 'Principal Repayment';
                } else if (txn.interestAllocationPaise > 0) {
                    tDesc = 'Interest Repayment';
                }

                doc.fillColor('#1E293B').font('Helvetica').fontSize(8);
                doc.text(String(index + 1), 48, currentY + 4);
                doc.text(tDate, 70, currentY + 4);
                doc.text(tDesc, 160, currentY + 4, { width: 240, ellipsis: true });
                doc.font('Helvetica-Bold').text(`Rs. ${tAmt}`, 410, currentY + 4);
                doc.fillColor('#166534').text('CONFIRMED', 485, currentY + 4);

                currentY += 18;
            });
        }

        doc.y = currentY + 15;

        // --- Legal Discharge Statement ---
        doc.fontSize(8.5).font('Helvetica-Oblique').fillColor('#475569').text(
            'Declaration: The Lender confirms that no further claims, pledges, collateral demands, or interest payments remain active against this account. This electronically verified No Objection Certificate (NOC) serves as irrefutable legal clearance under the Khaata Digital Ledger system.',
            40,
            doc.y,
            { align: 'justify', lineGap: 2 }
        );
        doc.moveDown(1.5);

        // --- Signature Section ---
        const sigY = doc.y;
        doc.rect(40, sigY, 230, 45).fillAndStroke('#F8FAFC', '#E2E8F0');
        doc.rect(325, sigY, 230, 45).fillAndStroke('#F8FAFC', '#E2E8F0');

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#0F172A').text('LENDER AUTHORIZATION', 50, sigY + 6);
        doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text(`Digitally Certified by: ${lenderName}`, 50, sigY + 18);
        doc.text(`Status: DUES CLEARED & SATISFIED`, 50, sigY + 30);

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#0F172A').text('PLATFORM VERIFICATION SEAL', 335, sigY + 6);
        doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text('Khaata Financial Protocol V2', 335, sigY + 18);
        doc.fillColor('#15803D').text('VERIFIED: ZERO OUTSTANDING DUES', 335, sigY + 30);

        doc.end();
    } catch (err) {
        console.error('[DownloadNOC] Error:', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Failed to generate NOC: ' + err.message });
        }
    }
};