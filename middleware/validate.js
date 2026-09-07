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
    body('amountPaise').notEmpty().not().isArray().withMessage('Amount cannot be an array').withMessage('amountPaise is required').isInt({ min: 10000, max: 100000000000 }).withMessage('amountPaise must be a positive integer in paise (min Rs 100)'),
    body('borrower_phone').notEmpty().withMessage('Borrower phone is required').matches(/^(\+91)?[6-9]\d{9}$/).withMessage('Enter a valid Indian phone number'),
    body('interest_rate').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0, max: 100 }).withMessage('Interest rate must be between 0 and 100'),
    body('duration_months').notEmpty().not().isArray().withMessage('Duration is required').isInt({ min: 1, max: 120 }).withMessage('Duration must be between 1 and 120'),
    body('borrower_name').notEmpty().withMessage('Borrower name is required').trim().isLength({ max: 100 }).withMessage('Name too long'),
    body('borrower_aadhar').optional({ nullable: true, checkFalsy: true }).isString(),
    body('borrower_address').optional({ nullable: true, checkFalsy: true }).isString(),
    body('duration_type').optional({ nullable: true, checkFalsy: true }).isString(),
    body('type').optional({ nullable: true, checkFalsy: true }).isString(),
    body('transaction_id').optional({ nullable: true, checkFalsy: true }).isString().withMessage('transaction_id must be a string'),
    body('documentId').optional({ nullable: true, checkFalsy: true }).isString(),
    handleValidationErrors
];

// Payment recording validation
const validatePaymentAmount = [
    body('amountPaise').notEmpty().not().isArray().withMessage('Amount cannot be an array').withMessage('amountPaise is required').isInt({ min: 1, max: 100000000000 }).withMessage('amountPaise must be a positive integer in paise'),
    body('idToken').optional().isString(),   // Firebase ID token (Admin SDK path — replaces old sessionInfo+otp)
    body('intentId').optional().isString(),  // TransactionIntent UUID for borrower consent
    body('otp').optional().isString(),        // kept for backward-compat route detection only
    body('verificationId').optional().isString(), // kept for backward-compat route detection only
    handleValidationErrors
];


module.exports = { validateRegister, validateCreateLoan, validatePaymentAmount, handleValidationErrors };
