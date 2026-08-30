const fs = require('fs');

let content = fs.readFileSync('controllers/loans.js', 'utf8');

// 1. Remove _handleCustomTransaction entirely (starts at `async function _handleCustomTransaction(req, res, actionType) {`)
// 2. Remove toggleMonthStatus entirely
// 3. Remove exports for recordPayment, addCredit, recordInterest
// 4. Remove exports for toggleMonthStatus
// The block from `async function _handleCustomTransaction` all the way to the end of `toggleMonthStatus` is contiguous!

const startStr = 'async function _handleCustomTransaction(req, res, actionType) {';
const startIndex = content.indexOf(startStr);
const endStr = 'console.error(\'[Loans] toggleMonthStatus Error:\', err);\n        res.status(500).json({ success: false, message: \'Server Error\' });\n    }\n};';
const endIndex = content.indexOf(endStr);

if (startIndex === -1 || endIndex === -1) {
    console.error('Boundaries not found for _handleCustomTransaction and toggleMonthStatus');
    process.exit(1);
}

const v2Handlers = `
// =========================================================================
// V2 PAYMENT AND CREDIT MUTATIONS
// =========================================================================

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
            const { verifyFirebaseOtp } = require('../utils/fcm');
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) return res.status(400).json({ success: false, message: verificationResult.message });
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.recordPayment(loanId, amountPaise, req.user.id, intentId);

        await require('../config/redis').cacheInvalidate(\`loans:given:\${result.loan.lender}\`, \`loans:taken:\${result.loan.borrower}\`);
        
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

        if (verificationId && otp) {
            const { verifyFirebaseOtp } = require('../utils/fcm');
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) return res.status(400).json({ success: false, message: verificationResult.message });
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.addCredit(loanId, amountPaise, req.user.id, intentId);

        await require('../config/redis').cacheInvalidate(\`loans:given:\${result.loan.lender}\`, \`loans:taken:\${result.loan.borrower}\`);

        res.status(200).json({ success: true, loan: result.loan });
    } catch (err) {
        console.error('[Loans V2] addCredit Error:', err.message);
        function sendError(res, err, status = 500) { res.status(status).json({ success: false, message: 'Server Error' }); }
        sendError(res, err);
    }
};
`;

content = content.substring(0, startIndex) + v2Handlers + content.substring(endIndex + endStr.length);

// Also fix verifyLoan
const verifyLoanStart = content.indexOf('exports.verifyLoan = async (req, res) => {');
const verifyLoanEndStr = 'res.status(200).json({ success: true, message: \'Loan verified successfully\' });\n    } catch (err) {\n        await session.abortTransaction();\n        session.endSession();\n        console.error(\'[Loans] verifyLoan Error:\', err);\n        res.status(500).json({ success: false, message: \'Server Error\' });\n    }\n};';
const verifyLoanEndIndex = content.indexOf(verifyLoanEndStr);

if (verifyLoanStart !== -1 && verifyLoanEndIndex !== -1) {
    const v2VerifyLoan = `exports.verifyLoan = async (req, res) => {
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

        if (verificationId && otp) {
            const { verifyFirebaseOtp } = require('../utils/fcm');
            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) {
                return res.status(400).json({ success: false, message: verificationResult.message });
            }
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.acceptLoan(loanId, req.user.id);
        
        await require('../config/redis').cacheInvalidate(\`loans:given:\${result.loan.lender}\`, \`loans:taken:\${result.loan.borrower}\`);

        res.status(200).json({ success: true, message: 'Loan verified successfully', loan: result.loan });
    } catch (err) {
        console.error('[Loans] verifyLoan Error:', err.message);
        res.status(500).json({ success: false, message: err.message || 'Server Error' });
    }
};`;
    content = content.substring(0, verifyLoanStart) + v2VerifyLoan + content.substring(verifyLoanEndIndex + verifyLoanEndStr.length);
}

// Remove monthsTracking from createLoan
content = content.replace(/const monthsTracking = \[\];\s*for \(let i = 1; i <= durationMonths; i\+\+\) {\s*monthsTracking\.push\({\s*monthIndex: i,\s*status: 'unpaid'\s*}\);\s*}\s*const loan = await Loan\.create\({/, 'const loan = await Loan.create({');
content = content.replace(/monthsTracking\s*\}\);/, '});');

fs.writeFileSync('controllers/loans.js', content);
console.log('Fixed controllers/loans.js');
