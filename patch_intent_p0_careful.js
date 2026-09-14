const fs = require('fs');
let ctrl = fs.readFileSync('controllers/loans.js', 'utf8');

// For addCredit, recordPayment we need to replace how amountPaise is assigned and remove intent.save
ctrl = ctrl.replace(
    /const amountPaise = Math\.round\(amount \* 100\);/g,
    `// amountPaise resolved later from intent`
);

ctrl = ctrl.replace(
    /if \(new Date\(\) > intent\.expiresAt\) return res\.status\(400\)\.json\(\{ success: false, message: 'Intent expired' \}\);/g,
    `if (new Date() > intent.expiresAt) return res.status(400).json({ success: false, message: 'Intent expired' });\n        const amountPaise = intent.payload && intent.payload.amountPaise ? intent.payload.amountPaise : null;`
);

// Remove the consumption logic
ctrl = ctrl.replace(/intent\.status = 'CONSUMED';\n\s*await intent\.save\(\);/g, '');

// Don't forget my deleteLoan -> cancelLoan patch which git restore undid!
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

ctrl = ctrl.replace(/exports\.deleteLoan = async \([\s\S]*?^};/m, newCancelLogic);

fs.writeFileSync('controllers/loans.js', ctrl);
console.log('Fixed controllers/loans.js carefully');
