const express = require('express');
const {
    getInterestSchedule,
    getRepaymentTimeline,
    createLoan,
    getGivenLoans,
    getTakenLoans,
    getLoanById,
    getPortfolioSummary,
    verifyLoan,
    verifyLenderOtp,
    requestClosureOtp,
    closeLoan,
    resendLoanOtp,
    updateProgress,
    recordPayment,
    addCredit,
    sendPaymentNudge,
    toggleMonthStatus,
    uploadDocument,
    cancelLoan
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
router.get('/portfolio-summary', getPortfolioSummary);
router.get('/taken', cacheMiddleware('taken_loans', 300), getTakenLoans);
router.get('/:id', getLoanById);
router.get('/:id/interest-schedule', getInterestSchedule);
router.get('/:id/repayment-timeline', getRepaymentTimeline);
  router.post('/:id/verify', financialLimiter, verifyLoan);
router.post('/:id/verify-lender-otp', financialLimiter, verifyLenderOtp);
router.post('/:id/close-otp', requestClosureOtp);
router.post('/:id/close', financialLimiter, closeLoan);
router.post('/:id/resend-otp', resendLoanOtp);
router.patch('/:id/progress', updateProgress);

// Custom Payments
router.post('/:id/payment-nudge', protect, apiLimiter, requireIdempotency, sendPaymentNudge);
router.post('/:id/record-payment', financialLimiter, requireIdempotency, validatePaymentAmount, recordPayment);
router.post('/:id/add-credit', validatePaymentAmount, addCredit);
router.patch('/:id/months/:monthIndex', protect, toggleMonthStatus);
router.post('/upload-document', uploadDocument);
router.post('/:id/cancel', cancelLoan);

module.exports = router;







