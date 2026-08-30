const fs = require('fs');
let c = fs.readFileSync('controllers/loans.js', 'utf8');
const start = c.indexOf('exports.verifyLoan = async');
const end = c.indexOf('exports.verifyLenderOtp = async');

const v2vl = `exports.verifyLoan = async (req, res) => {
    try {
        const { verificationId, otp } = req.body;
        const loanId = req.params.id;

        const loanRecord = await require('../models/Loan').findById(loanId);
        if (!loanRecord) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        if (loanRecord.borrowerPhone !== req.user.phone) {
            return res.status(403).json({ success: false, message: 'Only the borrower can accept this loan' });
        }

        if (loanRecord.status !== 'pending_approval') {
            return res.status(400).json({ success: false, message: 'Loan is not in a state to be accepted.' });
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const result = await FinancialLedgerService.acceptLoan(loanId, req.user.id);
        
        await require('../config/redis').cacheInvalidate(\`loans:given:\${result.loan.lender}\`, \`loans:taken:\${result.loan.borrower}\`);

        res.status(200).json({ success: true, message: 'Loan verified successfully', loan: result.loan });
    } catch (err) {
        console.error('[Loans] verifyLoan Error:', err.message);
        res.status(500).json({ success: false, message: err.message || 'Server Error' });
    }
};

`;

c = c.substring(0, start) + v2vl + c.substring(end);
fs.writeFileSync('controllers/loans.js', c);
console.log('Done');
