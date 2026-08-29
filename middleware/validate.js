const { body, validationResult, matchedData } = require('express-validator');

// Middleware to return validation errors AND enforce strict DTO mapping (stripping unknown fields)
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors.array().map(e => ({ field: e.path, message: e.msg })),
            requestId: req.id
        });
    }
    
    // Strict Input Protection: Discard all unknown fields (Mass Assignment block)
    // Only the fields explicitly declared in the validator chain survive
    req.body = matchedData(req, { locations: ['body'] });
    
    next();
};

// Auth register validation
const validateRegister = [
    body('phone').notEmpty().withMessage('Phone number is required').matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian phone number'),
    body('password').notEmpty().withMessage('Password is required').isLength({ min: 8 }).withMessage('Password must be at least 8 characters').matches(/[a-zA-Z]/).withMessage('Password must contain at least one letter').matches(/[0-9]/).withMessage('Password must contain at least one number'),
    body('email').optional().isEmail().withMessage('Enter a valid email address').normalizeEmail(),
    body('firstName').optional().isString().trim(),
    body('lastName').optional().isString().trim(),
    handleValidationErrors
];

// Loan create validation
const validateCreateLoan = [
    body('amount').notEmpty().withMessage('Amount is required').isInt({ min: 100, max: 1000000000 }).withMessage('Amount must be a positive integer in paise'),
    body('borrower_phone').notEmpty().withMessage('Borrower phone is required').matches(/^(\+91)?[6-9]\d{9}$/).withMessage('Enter a valid Indian phone number'),
    body('interest_rate').optional().isFloat({ min: 0, max: 100 }).withMessage('Interest rate must be between 0 and 100'),
    body('duration_months').notEmpty().withMessage('Duration is required').isInt({ min: 1, max: 120 }).withMessage('Duration must be between 1 and 120'),
    body('borrower_name').notEmpty().withMessage('Borrower name is required').trim().isLength({ max: 100 }).withMessage('Name too long'),
    handleValidationErrors
];

// Payment recording validation
const validatePaymentAmount = [
    body('amount').notEmpty().withMessage('Amount is required').isInt({ min: 1, max: 1000000000 }).withMessage('Amount must be a positive integer in paise'),
    body('otp').optional().isString(),
    body('verificationId').optional().isString(),
    handleValidationErrors
];

module.exports = { validateRegister, validateCreateLoan, validatePaymentAmount, handleValidationErrors };
