const express = require('express');
const { sendOtp, verifyOtp, verifyToken, register, getMe } = require('../controllers/auth');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/verify-token', verifyToken);
router.post('/register', protect, register);
router.get('/me', protect, getMe);

module.exports = router;
