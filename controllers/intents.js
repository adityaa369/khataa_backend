const TransactionIntent = require('../models/TransactionIntent');
const Loan = require('../models/Loan');

exports.createIntent = async (req, res) => {
    try {
        const { loanId, action, amountPaise, metadata } = req.body;
        
        // 1. Fetch Loan
        const loan = await Loan.findById(loanId);
        if (!loan) return res.status(404).json({ success: false, message: 'Loan not found' });
        
        // 2. Resource Authorization
        if (action === 'ACCEPT_LOAN') {
            if (loan.borrower.toString() !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Only the borrower can accept this loan' });
            }
        } else {
            // Lender actions
            if (loan.lender.toString() !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Only the lender can perform this action' });
            }
        }
        
        // 3. Loan State & FinancialStatus validation
        if (loan.status === 'frozen') {
            return res.status(400).json({ success: false, code: 'MUTATION_REJECTED', message: 'Loan is frozen' });
        }
        if (['closed', 'completed', 'rejected', 'cancelled', 'expired'].includes(loan.status) && action !== 'REVERSE') {
            return res.status(400).json({ success: false, code: 'MUTATION_REJECTED', message: 'Loan is in terminal state' });
        }
        
        // 4. Create Intent
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins expiry
        
        const intent = await TransactionIntent.create({
            loanId,
            userId: req.user.id,
            action,
            payload: {
                amountPaise: amountPaise || 0,
                metadata: metadata || {}
            },
            status: 'PENDING',
            expiresAt
        });
        
        res.status(201).json({ success: true, intentId: intent.intentId, expiresAt: intent.expiresAt });
    } catch (err) {
        console.error('[Intents] createIntent Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};
