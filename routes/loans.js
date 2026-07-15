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
    uploadDocument,
    recordPayment,
    addCredit,
    recordInterest
} = require('../controllers/loans');
const { protect } = require('../middleware/auth');
const { cacheMiddleware } = require('../middleware/cache');

const router = express.Router();

router.use(protect); // All loan routes are protected

router.post('/', createLoan);
router.get('/given', cacheMiddleware('given_loans', 300), getGivenLoans);
router.get('/taken', cacheMiddleware('taken_loans', 300), getTakenLoans);
router.post('/upload-document', uploadDocument);
router.post('/:id/verify', verifyLoan);
router.post('/:id/verify-lender-otp', verifyLenderOtp);
router.post('/:id/close-otp', requestClosureOtp);
router.post('/:id/close', closeLoan);
router.post('/:id/resend-otp', resendLoanOtp);
router.patch('/:id/progress', updateProgress);

// Custom Payments
router.post('/:id/record-payment', recordPayment);
router.post('/:id/add-credit', addCredit);
router.post('/:id/record-interest', recordInterest);

module.exports = router;
