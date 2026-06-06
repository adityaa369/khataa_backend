const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth');
const { protect } = require('../middleware/auth');

// Note: /send-otp is no longer needed since Firebase SDK sends it from the client
// We keep it returning success to not break existing app flows immediately 
// until Flutter is updated.
router.post('/send-otp', (req, res) => {
    res.status(200).json({ success: true, message: 'OTP flow shifted to Firebase client SDK.' });
});

router.post('/verify-otp', authController.verifyOtp);
router.post('/login-password', authController.loginPassword);
router.post('/register', protect, authController.register);
router.get('/me', protect, authController.getMe);

module.exports = router;
