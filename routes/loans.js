const express = require('express');
const {
    createLoan,
    getGivenLoans,
    getTakenLoans,
    verifyLoan,
    resendLoanOtp,
    updateProgress,
    uploadDocument,
    recordPayment,
    addCredit,
    recordInterest
} = require('../controllers/loans');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect); // All loan routes are protected

router.post('/', createLoan);
router.get('/given', getGivenLoans);
router.get('/taken', getTakenLoans);
router.post('/upload-document', uploadDocument);
router.post('/:id/verify', verifyLoan);
router.post('/:id/resend-otp', resendLoanOtp);
router.patch('/:id/progress', updateProgress);

// Custom Payments
router.post('/:id/record-payment', recordPayment);
router.post('/:id/add-credit', addCredit);
router.post('/:id/record-interest', recordInterest);

module.exports = router;
