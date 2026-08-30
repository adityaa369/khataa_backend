import re

with open('middleware/validate.js', 'r') as f:
    c = f.read()

replacement = """const validateCreateLoan = [
    body('amount').notEmpty().withMessage('Amount is required').isInt({ min: 100, max: 1000000000 }).withMessage('Amount must be a positive integer in paise'),
    body('borrower_phone').notEmpty().withMessage('Borrower phone is required').matches(/^(\\+91)?[6-9]\\d{9}$/).withMessage('Enter a valid Indian phone number'),
    body('interest_rate').optional().isFloat({ min: 0, max: 100 }).withMessage('Interest rate must be between 0 and 100'),
    body('duration_months').notEmpty().withMessage('Duration is required').isInt({ min: 1, max: 120 }).withMessage('Duration must be between 1 and 120'),
    body('borrower_name').notEmpty().withMessage('Borrower name is required').trim().isLength({ max: 100 }).withMessage('Name too long'),
    body('borrower_aadhar').optional().isString(),
    body('borrower_address').optional().isString(),
    body('duration_type').optional().isString(),
    body('type').optional().isString(),
    body('transaction_id').optional().isString().withMessage('transaction_id must be a string'),
    body('documentUrl').optional().isString(),
    handleValidationErrors
];"""

c = re.sub(r'const validateCreateLoan = \[\s*body.*?handleValidationErrors\s*\];', replacement, c, flags=re.DOTALL)

with open('middleware/validate.js', 'w') as f:
    f.write(c)
