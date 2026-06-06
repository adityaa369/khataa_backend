const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const CreditScore = require('../models/CreditScore');
const { verifyFirebaseToken } = require('../utils/otpProvider');

// @desc    Verify Firebase ID Token and login/register
// @route   POST /api/auth/verify-otp
// @access  Public
exports.verifyOtp = async (req, res) => {
    const idToken = req.body.idToken || req.body.otp;

    if (!idToken) {
        return res.status(400).json({ success: false, message: 'Please provide Firebase ID Token' });
    }

    try {
        const result = await verifyFirebaseToken(idToken);

        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }

        // Firebase returns phone number with +91.
        let phoneStr = result.mobile.replace(/\D/g, '');
        // Strip 91 if it's 12 digits (assuming India +91)
        if (phoneStr.startsWith('91') && phoneStr.length > 10) {
            phoneStr = phoneStr.substring(2);
        }

        let isNewUser = false;
        let user = await User.findOne({ phone: phoneStr });

        const registrationDetails = req.body.registrationDetails;
        let updates = {};
        if (registrationDetails) {
            const allowedFields = ['firstName', 'lastName', 'email', 'city'];
            allowedFields.forEach(field => {
                if (registrationDetails[field] !== undefined) {
                    updates[field] = registrationDetails[field];
                }
            });
            if (registrationDetails.password) {
                const salt = await bcrypt.genSalt(10);
                updates.password = await bcrypt.hash(registrationDetails.password, salt);
            }
        }

        if (!user) {
            const id = `user_${Date.now()}`;
            user = await User.create({
                id,
                phone: phoneStr,
                isVerified: true,
                ...updates
            });
            isNewUser = true;

            await CreditScore.create({
                user: user.id
            });
        } else if (registrationDetails) {
            user = await User.findOneAndUpdate(
                { phone: phoneStr },
                { $set: updates },
                { new: true }
            );
        }

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d'
        });

        res.status(200).json({
            success: true,
            token,
            isNewUser: isNewUser || !user.firstName,
            user
        });
    } catch (err) {
        console.error('[Auth] verifyOtp Error:', err.message);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

// @desc    Update Profile Details (Incremental)
// @route   POST /api/auth/register
// @access  Private
exports.register = async (req, res) => {
    const allowedFields = ['firstName', 'lastName', 'email', 'pan', 'aadhar', 'dob', 'gender', 'city'];
    const updates = {};

    allowedFields.forEach(field => {
        if (req.body[field] !== undefined) {
            updates[field] = req.body[field];
        }
    });

    try {
        if (req.body.password) {
            const salt = await bcrypt.genSalt(10);
            updates.password = await bcrypt.hash(req.body.password, salt);
        }

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
    try {
        const user = await User.findOne({ id: req.user.id });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        res.status(200).json({
            success: true,
            user
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Login with Phone and Password
// @route   POST /api/auth/login-password
// @access  Public
exports.loginPassword = async (req, res) => {
    let { phone, password } = req.body;

    if (!phone || !password) {
        return res.status(400).json({ success: false, message: 'Please provide phone and password' });
    }

    try {
        // Normalize phone number: strip non-digits and leading +91 / 91
        let phoneStr = phone.toString().replace(/\D/g, '');
        if (phoneStr.startsWith('91') && phoneStr.length > 10) {
            phoneStr = phoneStr.substring(2);
        }

        const user = await User.findOne({ phone: phoneStr });
        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid credentials. Mobile number not registered.' });
        }

        if (!user.password) {
            return res.status(400).json({ success: false, message: 'No password set for this account. Please use OTP login or register first.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid credentials. Wrong password.' });
        }

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d'
        });

        res.status(200).json({
            success: true,
            token,
            user
        });
    } catch (err) {
        console.error('[Auth] loginPassword Error:', err.message);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};
