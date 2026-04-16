const express = require('express');
const {
    createLoan,
    getGivenLoans,
    getTakenLoans,
    verifyLoan,
    resendLoanOtp,
    updateProgress,
    verifyLenderOtp,
    closeLoan
} = require('../controllers/loans');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect); // All loan routes are protected

router.post('/', createLoan);
router.get('/given', getGivenLoans);
router.get('/taken', getTakenLoans);
router.post('/:id/verify', verifyLoan);
router.post('/:id/verify-lender-otp', verifyLenderOtp);
router.post('/:id/resend-otp', resendLoanOtp);
router.patch('/:id/progress', updateProgress);
router.post('/:id/close', closeLoan);

module.exports = router;
