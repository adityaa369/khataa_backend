const fs = require('fs');
let c = fs.readFileSync('controllers/loans.js', 'utf8');

// 1 & 2 & 3 & 4. Replace _handleCustomTransaction block with V2 Handlers
const hctStart = c.indexOf('async function _handleCustomTransaction(req, res, actionType) {');
const hctEndStr = 'exports.recordInterest = (req, res) => _handleCustomTransaction(req, res, \'recordInterest\');';
const hctEnd = c.indexOf(hctEndStr);

if (hctStart !== -1 && hctEnd !== -1) {
    const v2Handlers = `exports.recordPayment = async (req, res) => {
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

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.recordPayment(loanId, amountPaise, req.user.id, intentId);
        
        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] recordPayment Error:', err.message);
        function sendError(res, err, status = 500) { res.status(status).json({ success: false, message: 'Server Error' }); }
        sendError(res, err);
    }
};

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

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.addCredit(loanId, amountPaise, req.user.id, intentId);

        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] addCredit Error:', err.message);
        function sendError(res, err, status = 500) { res.status(status).json({ success: false, message: 'Server Error' }); }
        sendError(res, err);
    }
};`;
    c = c.substring(0, hctStart) + v2Handlers + c.substring(hctEnd + hctEndStr.length);
}

// 5. Delete toggleMonthStatus
const tmsStart = c.indexOf('exports.toggleMonthStatus = async (req, res) => {');
if (tmsStart !== -1) {
    const tmsEndStr = 'res.status(500).json({ success: false, message: \'Server Error\' });\n    }\n};';
    const tmsEnd = c.indexOf(tmsEndStr, tmsStart);
    if (tmsEnd !== -1) {
        c = c.substring(0, tmsStart) + c.substring(tmsEnd + tmsEndStr.length);
    }
}

// 6. Replace verifyLoan
const vlStart = c.indexOf('exports.verifyLoan = async (req, res) => {');
const vlEndStr = 'res.status(500).json({ success: false, message: \'Server Error\' });\n    }\n};';
if (vlStart !== -1) {
    const vlEnd = c.indexOf(vlEndStr, vlStart);
    if (vlEnd !== -1) {
        const v2vl = `exports.verifyLoan = async (req, res) => {
    try {
        const { verificationId, otp } = req.body;
        const loanId = req.params.id;

        const loanRecord = await require('../models/Loan').findById(loanId);
        if (!loanRecord) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        if (loanRecord.borrower.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only the borrower can accept this loan' });
        }

        if (loanRecord.status !== 'pending_approval') {
            return res.status(400).json({ success: false, message: 'Loan is not in a state to be accepted.' });
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.acceptLoan(loanId, req.user.id);
        
        res.status(200).json({ success: true, message: 'Loan verified successfully', loan: result.loan });
    } catch (err) {
        console.error('[Loans] verifyLoan Error:', err.message);
        res.status(500).json({ success: false, message: err.message || 'Server Error' });
    }
};`;
        c = c.substring(0, vlStart) + v2vl + c.substring(vlEnd + vlEndStr.length);
    }
}

// 7. Remove monthsTracking from createLoan
c = c.replace(/const monthsTracking = \[\];\s*for \(let i = 1; i <= durationMonths; i\+\+\) {\s*monthsTracking\.push\({\s*monthIndex: i,\s*status: 'unpaid'\s*}\);\s*}\s*const loan = await Loan\.create\({/, 'const loan = await Loan.create({');
c = c.replace(/monthsTracking\s*\}\);/, '});');

// 8. Rename deleteLoan to cancelLoan
c = c.replace('exports.deleteLoan = async (req, res) => {', 'exports.cancelLoan = async (req, res) => {');
c = c.replace('if (![\'pending_otp\', \'pending_approval\'].includes(loan.status)) {', 'if (loan.status !== \'pending\') {');
c = c.replace('message: \'Only pending requests can be cancelled. Active loans cannot be deleted.\'', 'code: \'MUTATION_REJECTED\',\n                message: \'Only pending offers can be cancelled. Loans with financial history cannot be cancelled or deleted.\'');
c = c.replace('await Loan.findByIdAndDelete(req.params.id);', 'loan.status = \'cancelled\';\n        await loan.save();');

fs.writeFileSync('controllers/loans.js', c);
console.log('Fixed controllers/loans.js perfectly!');
