import os

val_path = 'middleware/validate.js'
with open(val_path, 'r', encoding='utf-8') as f:
    c = f.read()

c = c.replace(
    "const validatePaymentAmount = [\n    body('amount').notEmpty().withMessage('Amount is required').isInt({ min: 1, max: 1000000000 }).withMessage('Amount must be a positive integer in paise'),\n    handleValidationErrors\n];",
    "const validatePaymentAmount = [\n    body('amount').notEmpty().withMessage('Amount is required').isInt({ min: 1, max: 1000000000 }).withMessage('Amount must be a positive integer in paise'),\n    body('otp').optional().isString(),\n    body('verificationId').optional().isString(),\n    handleValidationErrors\n];"
)
with open(val_path, 'w', encoding='utf-8') as f:
    f.write(c)
    print("Fixed validate.js")

ctrl_path = 'controllers/loans.js'
with open(ctrl_path, 'r', encoding='utf-8') as f:
    c = f.read()

old_auth = """        // Verify Firebase OTP first
        if (!otp || !verificationId) {
            return res.status(400).json({ success: false, message: 'OTP and verificationId are required' });
        }
        
        const currentLoanForOtp = await Loan.findById(req.params.id);
        if (!currentLoanForOtp) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }
        if (currentLoanForOtp.lender !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only lender can record payments' });
        }

        const verificationResult = await verifyFirebaseOtp(verificationId, otp);
        if (!verificationResult.success) {
            return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid OTP' });
        }

        const returnedPhone = verificationResult.phone.replace(/\\D/g, '').slice(-10);"""

new_auth = """        // Verify Firebase OTP for payments
        let currentLoanForOtp;
        if (actionType !== 'addCredit') {
            if (!otp || !verificationId) {
                return res.status(400).json({ success: false, message: 'OTP and verificationId are required' });
            }
            
            currentLoanForOtp = await Loan.findById(req.params.id);
            if (!currentLoanForOtp) {
                return res.status(404).json({ success: false, message: 'Loan not found' });
            }
            if (currentLoanForOtp.lender !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Only lender can record payments' });
            }

            const verificationResult = await verifyFirebaseOtp(verificationId, otp);
            if (!verificationResult.success) {
                return res.status(400).json({ success: false, message: verificationResult.message || 'Invalid OTP' });
            }

            const returnedPhone = verificationResult.phone.replace(/\\D/g, '').slice(-10);
            const expectedPhone = currentLoanForOtp.borrowerPhone.replace(/\\D/g, '').slice(-10);
            
            if (returnedPhone !== expectedPhone) {
                return res.status(400).json({ success: false, message: 'OTP verified, but the phone number does not match the borrower.' });
            }
        } else {
            currentLoanForOtp = await Loan.findById(req.params.id);
            if (!currentLoanForOtp) {
                return res.status(404).json({ success: false, message: 'Loan not found' });
            }
            if (currentLoanForOtp.lender !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Only lender can add credit' });
            }
        }"""

# Actually, the original code had:
#         const returnedPhone = verificationResult.phone.replace(/\D/g, '').slice(-10);
#         const expectedPhone = currentLoanForOtp.borrowerPhone.replace(/\D/g, '').slice(-10);
#         
#         if (returnedPhone !== expectedPhone) {
#             return res.status(400).json({ success: false, message: 'OTP verified, but the phone number does not match the borrower.' });
#         }

# Wait, let's find the exact block:
idx1 = c.find("// Verify Firebase OTP first")
idx2 = c.find("        // Re-fetch loan with transaction session", idx1)
old_block = c[idx1:idx2]

c = c.replace(old_block, new_auth + "\n\n")

with open(ctrl_path, 'w', encoding='utf-8') as f:
    f.write(c)
    print("Fixed loans.js")
