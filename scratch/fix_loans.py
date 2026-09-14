import re

with open('controllers/loans.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Truncate at line 1190 (where the garbage starts)
# Let's find "if (recentNudge) {"
cutoff = 0
for i, line in enumerate(lines):
    if "if (recentNudge) {" in line:
        cutoff = i + 3
        break

valid_lines = lines[:cutoff]

# Now append the fixed sendPaymentNudge
valid_lines.extend([
    "        const title = 'Payment Nudge';\n",
    "        const body = 'Your lender has sent you a payment nudge. Please contact your lender to discuss your next payment.';\n",
    "        if (borrower) {\n",
    "            const NotificationOutbox = require('../models/NotificationOutbox');\n",
    "            await NotificationOutbox.create({\n",
    "                aggregateType: 'LOAN',\n",
    "                aggregateId: loan._id.toString(),\n",
    "                eventType: 'PAYMENT_NUDGE_SENT',\n",
    "                recipientUserId: borrower._id,\n",
    "                channel: 'PUSH',\n",
    "                payload: {\n",
    "                    title,\n",
    "                    body,\n",
    "                    loanId: loan._id.toString()\n",
    "                }\n",
    "            });\n",
    "        }\n",
    "        return res.status(200).json({ success: true, message: 'Payment nudge sent successfully.' });\n",
    "    } catch (err) {\n",
    "        console.error('[PaymentNudge] Error:', err);\n",
    "        return res.status(500).json({ success: false, message: 'Server Error' });\n",
    "    }\n",
    "};\n\n"
])

# Now append cancelLoan
cancel_loan_code = """
// @desc    Delete a pending loan request
// @route   DELETE /api/loans/:id
// @access  Private
exports.cancelLoan = async (req, res) => {
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
};
"""

valid_lines.append(cancel_loan_code)

with open('controllers/loans.js', 'w', encoding='utf-8') as f:
    f.writelines(valid_lines)

print("Fixed controllers/loans.js")
