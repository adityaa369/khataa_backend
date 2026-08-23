const express = require('express');
const {
    createLoan,
    getGivenLoans,
    getTakenLoans,
    verifyLoan,
    verifyLenderOtp,
    requestClosureOtp,
    closeLoan,
    resendLoanOtp,
    updateProgress,
    recordPayment,
    addCredit,
    recordInterest
} = require('../controllers/loans');
const { protect } = require('../middleware/auth');
const { cacheMiddleware } = require('../middleware/cache');
const { requireIdempotency } = require('../middleware/idempotency');
const { financialLimiter, apiLimiter } = require('../middleware/rateLimiter');
const { validateCreateLoan, validatePaymentAmount } = require('../middleware/validate');

const router = express.Router();

router.use(protect); // All loan routes are protected

router.post('/', validateCreateLoan, createLoan);
router.get('/given', cacheMiddleware('given_loans', 300), getGivenLoans);
router.get('/taken', cacheMiddleware('taken_loans', 300), getTakenLoans);
router.post('/:id/verify', financialLimiter, verifyLoan);
router.post('/:id/verify-lender-otp', financialLimiter, verifyLenderOtp);
router.post('/:id/close-otp', requestClosureOtp);
router.post('/:id/close', financialLimiter, closeLoan);
router.post('/:id/resend-otp', resendLoanOtp);
router.patch('/:id/progress', updateProgress);

// Custom Payments
router.post('/:id/record-payment', financialLimiter, requireIdempotency, validatePaymentAmount, recordPayment);
router.post('/:id/add-credit', validatePaymentAmount, addCredit);
router.post('/:id/record-interest', validatePaymentAmount, recordInterest);

module.exports = router;



