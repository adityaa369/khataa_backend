const fs = require('fs');

let c = fs.readFileSync('controllers/loans.js', 'utf8');

const newCancelLogic = `exports.cancelLoan = async (req, res) => {
    try {
        const loan = await require('../models/Loan').findById(req.params.id);
        
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        // Must be lender or borrower
        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not authorized to cancel this loan' });
        }

        // Only PENDING loans can be cancelled. 
        if (loan.status !== 'pending') {
            return res.status(400).json({ 
                success: false, 
                code: 'MUTATION_REJECTED',
                message: 'Only pending offers can be cancelled. Loans with financial history cannot be cancelled or deleted.' 
            });
        }

        loan.status = 'cancelled';
        await loan.save();
        
        res.status(200).json({ success: true, message: 'Loan cancelled successfully', loan });
    } catch (err) {
        console.error('[Loans] Cancel Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};`;

c = c.replace(/exports\.deleteLoan = async \([\s\S]*?^};/m, newCancelLogic);
fs.writeFileSync('controllers/loans.js', c);

let r = fs.readFileSync('routes/loans.js', 'utf8');
r = r.replace('deleteLoan', 'cancelLoan');
r = r.replace("router.delete('/:id', cancelLoan);", "router.post('/:id/cancel', requireFinancialEligibility, cancelLoan);");
fs.writeFileSync('routes/loans.js', r);

console.log("Replaced physical deleteLoan with state-transition cancelLoan");
