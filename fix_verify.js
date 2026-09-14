const fs = require('fs');
let c = fs.readFileSync('controllers/loans.js', 'utf8');

const verifyLoanStart = c.indexOf('exports.verifyLoan = async (req, res) => {');
const verifyLoanEndStr = 'res.status(200).json({ success: true, message: \'Loan verified successfully\' });\n    } catch (err) {\n        await session.abortTransaction();\n        session.endSession();\n        console.error(\'[Loans] verifyLoan Error:\', err);\n        res.status(500).json({ success: false, message: \'Server Error\' });\n    }\n};';
const verifyLoanEndIndex = c.indexOf(verifyLoanEndStr);

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
    c = c.substring(0, verifyLoanStart) + v2VerifyLoan + c.substring(verifyLoanEndIndex + verifyLoanEndStr.length);
    fs.writeFileSync('controllers/loans.js', c);
    console.log('Fixed verifyLoan');
} else {
    console.log('verifyLoan not found');
}
