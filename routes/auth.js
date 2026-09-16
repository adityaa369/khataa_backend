const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth');
const { protect } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const { validateRegister } = require('../middleware/validate');

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Too many authentication attempts, please wait.' },
});

// Note: /send-otp is no longer needed since Firebase SDK sends it from the client
// We keep it returning success to not break existing app flows immediately 
// until Flutter is updated.
router.post('/send-otp', authLimiter, (req, res) => {
    res.status(200).json({ success: true, message: 'OTP flow shifted to Firebase client SDK.' });
});

router.post('/verify-otp', authLimiter, authController.verifyOtp);
router.post('/login-password', authLimiter, authController.loginPassword);
router.post('/send-otp-msg91', authLimiter, authController.sendOtpMsg91);
router.post('/verify-otp-msg91', authLimiter, authController.verifyOtpMsg91);
router.post('/register', protect, validateRegister, authController.register);
router.get('/me', protect, authController.getMe);
router.get('/verify-email/:token', authController.verifyEmail);
router.post('/sync-firebase', protect, authController.syncFirebase);
router.get('/firebase-custom-token', protect, authController.getFirebaseCustomToken);

router.post('/mpin/setup', protect, authController.setupMpin);
router.post('/mpin/change', protect, authController.changeMpin);
router.post('/mpin/verify', authLimiter, authController.verifyMpin);
router.get('/mpin/status', protect, authController.getMpinStatus);

router.get('/sessions', protect, authController.getSessions);
router.delete('/sessions/:sessionId', protect, authController.revokeSession);
router.post('/sessions/revoke-others', protect, authController.revokeOtherSessions);
router.get('/security-events', protect, authController.getSecurityEvents);

module.exports = router;
