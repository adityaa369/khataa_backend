const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
    getAadhaarKycStatus,
    sendAadhaarOtp,
    verifyAadhaarOtp
} = require('../controllers/kyc');

router.use(protect);

router.get('/aadhaar/status', getAadhaarKycStatus);
router.post('/aadhaar/send-otp', sendAadhaarOtp);
router.post('/aadhaar/verify-otp', verifyAadhaarOtp);

module.exports = router;
