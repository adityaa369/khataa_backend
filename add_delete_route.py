import re

# 1. Add deleteLoan to controllers/loans.js
controller_path = 'controllers/loans.js'
with open(controller_path, 'r', encoding='utf-8') as f:
    content = f.read()

delete_fn = """
// @desc    Delete a pending loan request
// @route   DELETE /api/loans/:id
// @access  Private
exports.deleteLoan = async (req, res) => {
    try {
        const loan = await Loan.findById(req.params.id);
        
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }

        if (loan.userId.toString() !== req.user.id && loan.lenderId.toString() !== req.user.id) {
            return res.status(401).json({ success: false, message: 'Not authorized to delete this loan' });
        }

        if (!['pending_otp', 'pending_approval'].includes(loan.status)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Only pending requests can be cancelled. Active loans cannot be deleted.' 
            });
        }

        await Loan.findByIdAndDelete(req.params.id);
        
        res.status(200).json({ success: true, data: {} });
    } catch (err) {
        console.error('[Loans] Delete Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
"""

if "exports.deleteLoan" not in content:
    content += "\n" + delete_fn

with open(controller_path, 'w', encoding='utf-8') as f:
    f.write(content)


# 2. Add route to routes/loans.js
router_path = 'routes/loans.js'
with open(router_path, 'r', encoding='utf-8') as f:
    content = f.read()

if "deleteLoan" not in content:
    content = content.replace("toggleMonthStatus\n}", "toggleMonthStatus,\n    deleteLoan\n}")
    content = content.replace("module.exports = router;", "router.delete('/:id', deleteLoan);\n\nmodule.exports = router;")

with open(router_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Backend updated.")
