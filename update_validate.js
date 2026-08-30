const fs = require('fs');

let val = fs.readFileSync('middleware/validate.js', 'utf8');

val = val.replace(/const validateCreateLoan = \[[\s\S]*?handleValidationErrors\n\];/, `const validateCreateLoan = [
    body('amount').notEmpty().withMessage('Amount is required').isNumeric().withMessage('Amount must be a number'),
    body('borrower_phone').notEmpty().withMessage('Borrower phone is required').isString().withMessage('Borrower phone must be a string'),
    body('interest_rate').optional().isFloat({ min: 0, max: 100 }).withMessage('Interest rate must be between 0 and 100'),
    body('duration_months').notEmpty().withMessage('Duration is required').isInt({ min: 1, max: 120 }).withMessage('Duration must be between 1 and 120'),
    body('borrower_name').optional().isString().trim(),
    body('borrower_aadhar').optional().isString(),
    body('borrower_address').optional().isString(),
    body('duration_type').optional().isString(),
    body('type').optional().isString(),
    body('transaction_id').optional().isString().withMessage('transaction_id must be a string'),
    body('documentUrl').optional().isString(),
    handleValidationErrors
];`);

// Wait, the user specifically mentioned:
// "For the $ne/object-in-scalar case: HTTP 400 code: INVALID_FIELD_TYPE"
// Express-validator validation errors normally return 400 with `code: 'VALIDATION_ERROR'`.
// Is that okay? The user said: "central error middleware ... validation error -> 400"

fs.writeFileSync('middleware/validate.js', val);
console.log('Updated middleware/validate.js');
