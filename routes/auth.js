const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth');
const { protect } = require('../middleware/auth');
const { authLimiter, otpLimiter } = require('../middleware/rateLimiter');

const { validateRegister } = require('../middleware/validate');

// Note: /send-otp is no longer needed since Firebase SDK sends it from the client
// We keep it returning success to not break existing app flows immediately 
// until Flutter is updated.
router.post('/send-otp', (req, res) => {
    res.status(200).json({ success: true, message: 'OTP flow shifted to Firebase client SDK.' });
});

router.post('/verify-otp', otpLimiter, authController.verifyOtp);
router.post('/login-password', authLimiter, authController.loginPassword);
router.post('/register', authLimiter, protect, validateRegister, authController.register);
router.get('/me', protect, authController.getMe);
router.get('/verify-email/:token', authController.verifyEmail);


router.post('/refresh', authController.refreshToken);
router.post('/logout', protect, authController.logout);
router.get('/sessions', protect, authController.getSessions);
router.delete('/sessions/:sessionId', protect, authController.revokeSession);
router.post('/forgot-password', authLimiter, authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

module.exports = router;



