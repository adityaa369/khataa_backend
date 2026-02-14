const jwt = require('jsonwebtoken');
const User = require('../models/User');
const CreditScore = require('../models/CreditScore');
const { sendOtp, verifyOtp, verifyAccessToken } = require('../utils/otpProvider');

// @desc    Verify MSG91 Access Token
// @route   POST /api/auth/verify-token
// @access  Public
exports.verifyToken = async (req, res) => {
    const { accessToken } = req.body;

    if (!accessToken) {
        return res.status(400).json({ success: false, message: 'Please provide an access token' });
    }

    console.log(`[Auth] Verifying Access Token: ${accessToken.substring(0, 10)}...`);
    const result = await verifyAccessToken(accessToken);

    if (!result.success || !result.mobile) {
        console.error('[Auth] MSG91 Verification failed:', result.message || 'Mobile undefined');
        return res.status(400).json({ success: false, message: result.message || 'Verification failed' });
    }

    // Strip '91' if it starts with it (MSG91 standard for India)
    const phone = result.mobile.toString().replace(/^91/, '');
    console.log(`[Auth] Verified Token for phone: ${phone}`);

    // Check if user exists
    let user = await User.findOne({ phone });
    let isNewUser = false;

    if (!user) {
        // Create initial user
        console.log(`[Auth] Creating new user for phone: ${phone}`);
        const id = `user_${Date.now()}`;
        user = await User.create({
            id,
            phone,
            isVerified: true
        });
        isNewUser = true;

        // Create initial credit score record
        await CreditScore.create({
            user: user.id
        });
    }

    // Create token
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
        expiresIn: '30d'
    });

    res.status(200).json({
        success: true,
        token,
        isNewUser: isNewUser || !user.firstName,
        user
    });
};

// @desc    Send OTP to phone (Direct)
// @route   POST /api/auth/send-otp
// @access  Public
exports.sendOtp = async (req, res) => {
    const { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ success: false, message: 'Please provide a phone number' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const result = await sendOtp(phone, otp);

    if (result.success) {
        res.status(200).json({ success: true, message: 'OTP sent successfully', dev_otp: otp });
    } else {
        res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
};

// @desc    Verify OTP and return token (Legacy/Direct)
// @route   POST /api/auth/verify-otp
// @access  Public
exports.verifyOtp = async (req, res) => {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
        return res.status(400).json({ success: false, message: 'Please provide phone and OTP' });
    }

    const result = await verifyOtp(phone, otp);

    if (!result.success) {
        return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    // Check if user exists
    let user = await User.findOne({ phone });
    let isNewUser = false;

    if (!user) {
        const id = `user_${Date.now()}`;
        user = await User.create({
            id,
            phone,
            isVerified: true
        });
        isNewUser = true;

        await CreditScore.create({
            user: user.id
        });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
        expiresIn: '30d'
    });

    res.status(200).json({
        success: true,
        token,
        isNewUser,
        user
    });
};

// @desc    Update Profile Details (Incremental)
// @route   POST /api/auth/register
// @access  Private
exports.register = async (req, res) => {
    const allowedFields = ['firstName', 'lastName', 'email', 'pan', 'aadhar', 'dob', 'gender'];
    const updates = {};

    allowedFields.forEach(field => {
        if (req.body[field] !== undefined) {
            updates[field] = req.body[field];
        }
    });

    try {
        const user = await User.findOneAndUpdate(
            { id: req.user.id },
            { $set: updates },
            { new: true, runValidators: true }
        );

        res.status(200).json({
            success: true,
            user
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

// @desc    Get Current Logged in user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
    const user = await User.findOne({ id: req.user.id });

    res.status(200).json({
        success: true,
        user
    });
};
