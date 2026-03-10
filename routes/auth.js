const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth');

// Note: /send-otp is no longer needed since Firebase SDK sends it from the client
// We keep it returning success to not break existing app flows immediately 
// until Flutter is updated.
router.post('/send-otp', (req, res) => {
    res.status(200).json({ success: true, message: 'OTP flow shifted to Firebase client SDK.' });
});

router.post('/verify-otp', authController.verifyOtp);
router.post('/verify-token', authController.verifyToken); // Keep for legacy if needed
router.post('/register', require('../middleware/auth').protect, authController.register);
router.get('/me', require('../middleware/auth').protect, authController.getMe);

module.exports = router;
