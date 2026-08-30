const fs = require('fs');

const file = 'controllers/loans.js';
let content = fs.readFileSync(file, 'utf8');

// We are going to replace:
// 1. verifyLoan (Accept)
// 2. _handleCustomTransaction (which handles recordPayment, addCredit, recordInterest)
// 3. closeLoan

const verifyLoanReplacement = `
exports.verifyLoan = async (req, res) => {
    try {
        const { intentId, verificationId, otp, idempotencyKey } = req.body;
        const loanId = req.params.id;

        // Intent Validation
        const TransactionIntent = require('../models/TransactionIntent');
        const intent = await TransactionIntent.findOne({ intentId, loanId, action: 'ACCEPT_LOAN', status: 'PENDING' });
        if (!intent) return res.status(400).json({ success: false, message: 'Invalid, missing, or expired intent' });
        if (intent.userId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Intent user mismatch' });
        if (new Date() > intent.expiresAt) return res.status(400).json({ success: false, message: 'Intent expired' });

        // OTP Validation (Mocked/Firebase)
        if (verificationId && otp) {
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) return res.status(400).json({ success: false, message: verificationResult.message });
        }

        // Mark intent consumed
        intent.status = 'CONSUMED';
        await intent.save();

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.acceptLoan(loanId, req.user.id, intentId);

        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] verifyLoan Error:', err.message);
        sendError(res, err);
    }
};
`;

const closeLoanReplacement = `
exports.closeLoan = async (req, res) => {
    try {
        const { intentId, verificationId, otp, idempotencyKey } = req.body;
        const loanId = req.params.id;

        const TransactionIntent = require('../models/TransactionIntent');
        const intent = await TransactionIntent.findOne({ intentId, loanId, action: 'CLOSE_LOAN', status: 'PENDING' });
        if (!intent) return res.status(400).json({ success: false, message: 'Invalid, missing, or expired intent' });
        if (intent.userId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Intent user mismatch' });
        if (new Date() > intent.expiresAt) return res.status(400).json({ success: false, message: 'Intent expired' });

        if (verificationId && otp) {
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) return res.status(400).json({ success: false, message: verificationResult.message });
        }

        intent.status = 'CONSUMED';
        await intent.save();

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.writeOffAndClose(loanId, req.user.id, intentId);

        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] closeLoan Error:', err.message);
        sendError(res, err);
    }
};
`;

const recordPaymentReplacement = `
exports.recordPayment = async (req, res) => {
    try {
        const { amount, intentId, verificationId, otp, idempotencyKey } = req.body;
        const loanId = req.params.id;
        const amountPaise = Math.round(amount * 100);

        const TransactionIntent = require('../models/TransactionIntent');
        const intent = await TransactionIntent.findOne({ intentId, loanId, action: 'RECORD_PAYMENT', status: 'PENDING' });
        if (!intent) return res.status(400).json({ success: false, message: 'Invalid, missing, or expired intent' });
        if (intent.userId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Intent user mismatch' });
        if (new Date() > intent.expiresAt) return res.status(400).json({ success: false, message: 'Intent expired' });

        if (verificationId && otp) {
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) return res.status(400).json({ success: false, message: verificationResult.message });
        }

        intent.status = 'CONSUMED';
        await intent.save();

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.recordPayment(loanId, amountPaise, req.user.id, intentId);

        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] recordPayment Error:', err.message);
        sendError(res, err);
    }
};
`;

const addCreditReplacement = `
exports.addCredit = async (req, res) => {
    try {
        const { amount, intentId, verificationId, otp, idempotencyKey } = req.body;
        const loanId = req.params.id;
        const amountPaise = Math.round(amount * 100);

        const TransactionIntent = require('../models/TransactionIntent');
        const intent = await TransactionIntent.findOne({ intentId, loanId, action: 'ADD_CREDIT', status: 'PENDING' });
        if (!intent) return res.status(400).json({ success: false, message: 'Invalid, missing, or expired intent' });
        if (intent.userId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Intent user mismatch' });
        if (new Date() > intent.expiresAt) return res.status(400).json({ success: false, message: 'Intent expired' });

        if (verificationId && otp) {
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) return res.status(400).json({ success: false, message: verificationResult.message });
        }

        intent.status = 'CONSUMED';
        await intent.save();

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.addCredit(loanId, amountPaise, req.user.id, intentId);

        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] addCredit Error:', err.message);
        sendError(res, err);
    }
};
`;

const reverseTransactionReplacement = `
exports.reverseTransaction = async (req, res) => {
    try {
        const { targetTxId, intentId, verificationId, otp, idempotencyKey } = req.body;
        const loanId = req.params.id;

        const TransactionIntent = require('../models/TransactionIntent');
        const intent = await TransactionIntent.findOne({ intentId, loanId, action: 'REVERSE', status: 'PENDING' });
        if (!intent) return res.status(400).json({ success: false, message: 'Invalid, missing, or expired intent' });
        if (intent.userId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Intent user mismatch' });
        if (new Date() > intent.expiresAt) return res.status(400).json({ success: false, message: 'Intent expired' });

        intent.status = 'CONSUMED';
        await intent.save();

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.reverseTransaction(loanId, targetTxId, req.user.id, intentId);

        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] reverse Error:', err.message);
        sendError(res, err);
    }
};
`;

// Regex replace verifyLoan
content = content.replace(/exports\.verifyLoan = async \(req, res\) => \{[\s\S]*?\n\};\n/m, verifyLoanReplacement);

// Regex replace closeLoan
content = content.replace(/exports\.closeLoan = async \(req, res\) => \{[\s\S]*?\n\};\n/m, closeLoanReplacement);

// Regex replace _handleCustomTransaction
content = content.replace(/async function _handleCustomTransaction[\s\S]*?\n\}/m, '');

// Regex replace exports for custom transactions
content = content.replace(/exports\.recordPayment = \(req, res\) => _handleCustomTransaction\(req, res, 'recordPayment'\);/m, recordPaymentReplacement);
content = content.replace(/exports\.addCredit = \(req, res\) => _handleCustomTransaction\(req, res, 'addCredit'\);/m, addCreditReplacement);
content = content.replace(/exports\.recordInterest = \(req, res\) => _handleCustomTransaction\(req, res, 'recordInterest'\);/m, reverseTransactionReplacement); // Put reverse here since recordInterest is deprecated in favor of worker

fs.writeFileSync(file, content);
console.log("Refactored controllers/loans.js successfully.");
