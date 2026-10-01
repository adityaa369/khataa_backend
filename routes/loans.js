const express = require('express');
const {
    createLoan,
    getGivenLoans,
    getTakenLoans,
    getLoanById,
    verifyLoan,
    verifyLenderOtp,
    requestClosureOtp,
    closeLoan,
    resendLoanOtp,
    updateProgress,
    uploadDocument,
    recordPayment,
    addCredit,
    recordInterest,
    getPortfolioSummary
} = require('../controllers/loans');
const { protect } = require('../middleware/auth');
const { cacheMiddleware } = require('../middleware/cache');
const { validateCreateLoan, validatePaymentAmount } = require('../middleware/validate');
const { commitPayment, initiatePayment } = require('../controllers/payments');

const router = express.Router();

router.use(protect); // All loan routes are protected

router.post('/', validateCreateLoan, createLoan);
router.get('/given', cacheMiddleware('given_loans', 300), getGivenLoans);
router.get('/taken', cacheMiddleware('taken_loans', 300), getTakenLoans);
router.get('/portfolio-summary', getPortfolioSummary);
router.get('/:id', getLoanById);
router.post('/upload-document', uploadDocument);
router.post('/:id/verify', verifyLoan);
router.post('/:id/verify-lender-otp', verifyLenderOtp);
router.post('/:id/close-otp', requestClosureOtp);
router.post('/:id/close', closeLoan);
router.post('/:id/resend-otp', resendLoanOtp);
router.patch('/:id/progress', updateProgress);
router.get('/:id/timeline', require('../controllers/loans').getRepaymentTimeline);
router.get('/:id/interest-schedule', require('../controllers/loans').getInterestSchedule);

// Custom Payments
router.post('/:id/record-payment', validatePaymentAmount, recordPayment);
router.post('/:id/payments/initiate', validatePaymentAmount, initiatePayment);
router.post('/:id/payments/commit', commitPayment); // Two-stage OTP-authorized payment
router.post('/:id/commit-payment', commitPayment); // Legacy fallback
router.post('/:id/add-credit', validatePaymentAmount, addCredit);
router.post('/:id/record-interest', validatePaymentAmount, recordInterest);

module.exports = router;
