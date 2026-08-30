const fs = require('fs');
let content = fs.readFileSync('controllers/loans.js', 'utf8');

// Find and remove the orphaned V1 block (lines 739-865 in current state)
// The block starts at the orphaned "let currentLoanForOtp;" and ends at the three bad export bindings.
const v1Start = content.indexOf('\n        let currentLoanForOtp;');
const v1End = content.indexOf("exports.recordInterest = (req, res) => _handleCustomTransaction(req, res, 'recordInterest');");

if (v1Start === -1 || v1End === -1) {
    console.error('Could not find V1 block boundaries');
    process.exit(1);
}

const v1EndFull = v1End + "exports.recordInterest = (req, res) => _handleCustomTransaction(req, res, 'recordInterest');".length;

const v2Handlers = `

// ─── V2 Payment & Credit Mutations ────────────────────────────────────────────
// Both operations delegate exclusively to FinancialLedgerService.
// The amount is read from the persisted TransactionIntent (P0 tampering fix).

// @desc    Record a payment against a loan (Lender-initiated, Intent + OTP required)
// @route   POST /api/loans/:id/record-payment
// @access  Private (Lender only — enforced inside FLS)
exports.recordPayment = async (req, res) => {
    try {
        const { intentId, verificationId, otp } = req.body;
        const loanId = req.params.id;

        const TransactionIntent = require('../models/TransactionIntent');
        const intent = await TransactionIntent.findOne({
            intentId, loanId, action: 'RECORD_PAYMENT', status: 'PENDING'
        });
        if (!intent) return res.status(400).json({ success: false, message: 'Invalid, missing, or expired intent' });
        if (intent.userId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Intent user mismatch' });
        if (new Date() > intent.expiresAt) return res.status(400).json({ success: false, message: 'Intent expired' });

        const amountPaise = intent.payload && intent.payload.amountPaise;
        if (!amountPaise) return res.status(400).json({ success: false, message: 'Intent missing payment amount' });

        if (verificationId && otp) {
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) return res.status(400).json({ success: false, message: verificationResult.message });
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.recordPayment(loanId, amountPaise, req.user.id, intentId);

        await invalidateLoanCache(result.loan.lender, result.loan.borrower);
        metrics.financial.paymentsCommitted++;
        trackFinancialEvent('LOAN_PAYMENT_COMMITTED', { loanId: result.loan._id, amountPaise });

        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] recordPayment Error:', err.message);
        sendError(res, err);
    }
};

// @desc    Add credit (increase principal) against a loan (Lender-initiated, Intent + OTP required)
// @route   POST /api/loans/:id/add-credit
// @access  Private (Lender only — enforced inside FLS)
exports.addCredit = async (req, res) => {
    try {
        const { intentId, verificationId, otp } = req.body;
        const loanId = req.params.id;

        const TransactionIntent = require('../models/TransactionIntent');
        const intent = await TransactionIntent.findOne({
            intentId, loanId, action: 'ADD_CREDIT', status: 'PENDING'
        });
        if (!intent) return res.status(400).json({ success: false, message: 'Invalid, missing, or expired intent' });
        if (intent.userId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Intent user mismatch' });
        if (new Date() > intent.expiresAt) return res.status(400).json({ success: false, message: 'Intent expired' });

        const amountPaise = intent.payload && intent.payload.amountPaise;
        if (!amountPaise) return res.status(400).json({ success: false, message: 'Intent missing credit amount' });

        if (verificationId && otp) {
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) return res.status(400).json({ success: false, message: verificationResult.message });
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.addCredit(loanId, amountPaise, req.user.id, intentId);

        await invalidateLoanCache(result.loan.lender, result.loan.borrower);
        trackFinancialEvent('CREDIT_ADDED', { loanId: result.loan._id, amountPaise });

        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] addCredit Error:', err.message);
        sendError(res, err);
    }
};
`;

content = content.substring(0, v1Start) + v2Handlers + content.substring(v1EndFull);
fs.writeFileSync('controllers/loans.js', content);
console.log('V1 _handleCustomTransaction removed. V2 handlers installed.');

// Verify
const check = fs.readFileSync('controllers/loans.js', 'utf8');
const banned = ['_handleCustomTransaction', 'totalPayable', 'paidAmount', 'transactions.push', 'loan_given', 'recordInterest'];
let clean = true;
banned.forEach(term => {
    const lines = check.split('\n').filter((l, i) => l.includes(term) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    if (lines.length > 0) {
        console.error(`STILL FOUND "${term}":`, lines.slice(0, 3).join(' | '));
        clean = false;
    }
});
if (clean) console.log('Post-fix scan: CLEAN — no V1 financial patterns remain.');
