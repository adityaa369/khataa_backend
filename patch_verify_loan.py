import re

with open('controllers/loans.js', 'r', encoding='utf-8') as f:
    content = f.read()

new_verify_loan = """// @desc    Verify/Approve loan agreement (Borrower Self-Verification)
// @route   POST /api/loans/:id/verify
// @access  Private (Borrower)
exports.verifyLoan = async (req, res) => {
    try {
        const { otp } = req.body;
        const loanId = req.params.id;
        
        // Hand off to FinancialLedgerService to initialize ledger balances & outbox
        const FinancialLedgerService = require('../services/FinancialLedgerService');
        const { loan } = await FinancialLedgerService.acceptLoan(loanId, req.user.id, null);

        const { invalidateLoanCache } = require('../services/cacheService');
        await invalidateLoanCache(loan.lender, loan.borrower);

        res.status(200).json({
            success: true,
            message: 'Loan accepted and activated successfully',
            loan
        });
    } catch (err) {
        console.error('[Loans] verifyLoan Error:', err.message);
        if (err.message.includes('UNAUTHORIZED_ACTION')) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        res.status(400).json({ success: false, message: err.message });
    }
};"""

content = re.sub(
    r"// @desc    Verify/Approve loan agreement \(Borrower Self-Verification\).*?exports\.verifyLoan = async \(req, res\) => \{.*?\n\};\n",
    new_verify_loan + "\n",
    content,
    flags=re.DOTALL
)

with open('controllers/loans.js', 'w', encoding='utf-8') as f:
    f.write(content)
