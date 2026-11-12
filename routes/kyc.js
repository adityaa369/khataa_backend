const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
    getAadhaarKycStatus,
    sendAadhaarOtp,
    verifyAadhaarOtp,
    handleDigiLockerCallback,
    resetAadhaarKyc
} = require('../controllers/kyc');

// Public OAuth callback for UIDAI MeriPehchaan DigiLocker redirect
router.get('/aadhaar/callback', handleDigiLockerCallback);

// Protected Aadhaar eKYC endpoints
router.use(protect);
router.get('/aadhaar/status', getAadhaarKycStatus);
router.post('/aadhaar/send-otp', sendAadhaarOtp);
router.post('/aadhaar/verify-otp', verifyAadhaarOtp);
router.post('/aadhaar/reset', resetAadhaarKyc);

module.exports = router;
