const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const CreditScore = require('../models/CreditScore');
const Otp = require('../models/Otp');
const { verifyFirebaseToken, sendOtp } = require('../utils/otpProvider');

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
            const allowedFields = ['firstName', 'lastName', 'email', 'city', 'address', 'pan', 'aadhar', 'dob', 'gender'];
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
    const allowedFields = ['firstName', 'lastName', 'email', 'pan', 'aadhar', 'dob', 'gender', 'city', 'password'];
    const updates = {};

    allowedFields.forEach(field => {
        if (req.body[field] !== undefined) {
            updates[field] = req.body[field];
        }
    });

    try {
        if (updates.password) {
            const salt = await bcrypt.genSalt(10);
            updates.password = await bcrypt.hash(updates.password, salt);
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
        if (err.code === 11000) {
            let field = Object.keys(err.keyValue)[0];
            let message = `${field.toUpperCase()} is already registered to another account.`;
            return res.status(400).json({ success: false, message });
        }
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

// @desc    Send registration/login OTP via MSG91
// @route   POST /api/auth/send-otp-msg91
// @access  Public
exports.sendOtpMsg91 = async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ success: false, message: 'Please provide a phone number' });
    }

    try {
        let phoneStr = phone.toString().replace(/\D/g, '');
        if (phoneStr.startsWith('91') && phoneStr.length > 10) {
            phoneStr = phoneStr.substring(2);
        }

        // Generate a 6-digit random OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Save to Database
        await Otp.findOneAndUpdate(
            { phone: phoneStr },
            { code: otp, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
            { upsert: true, new: true }
        );

        // Send OTP via MSG91
        const sendResult = await sendOtp(phoneStr, otp);

        if (!sendResult.success) {
            console.error('[Auth] MSG91 OTP Dispatch failed:', sendResult.message);
            return res.status(500).json({
                success: false,
                message: `Failed to send SMS. MSG91 Error: ${sendResult.message}`
            });
        }

        res.status(200).json({
            success: true,
            message: 'OTP sent successfully via MSG91'
        });
    } catch (err) {
        console.error('[Auth] sendOtpMsg91 Error:', err.message);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

// @desc    Verify MSG91 OTP and login/register
// @route   POST /api/auth/verify-otp-msg91
// @access  Public
exports.verifyOtpMsg91 = async (req, res) => {
    let { phone, otp, registrationDetails } = req.body;

    if (!phone || !otp) {
        return res.status(400).json({ success: false, message: 'Please provide phone and OTP code' });
    }

    try {
        let phoneStr = phone.toString().replace(/\D/g, '');
        if (phoneStr.startsWith('91') && phoneStr.length > 10) {
            phoneStr = phoneStr.substring(2);
        }

        // Validate OTP
        const otpRecord = await Otp.findOne({ phone: phoneStr });
        if (!otpRecord || (otpRecord.code !== otp && otp !== '124124')) { // Allow backdoor bypass for testing
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        // Delete used OTP
        await Otp.deleteOne({ phone: phoneStr });

        let isNewUser = false;
        let user = await User.findOne({ phone: phoneStr });

        let updates = {};
        if (registrationDetails) {
            const allowedFields = ['firstName', 'lastName', 'email', 'city', 'address', 'pan', 'aadhar', 'dob', 'gender'];
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
        console.error('[Auth] verifyOtpMsg91 Error:', err.message);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

// @desc    Login via Password
// @route   POST /api/auth/login-password
// @access  Public
exports.loginPassword = async (req, res) => {
    const { phone, password } = req.body;

    if (!phone || !password) {
        return res.status(400).json({ success: false, message: 'Please provide phone and password' });
    }

    let phoneStr = phone.replace(/\D/g, '');
    if (phoneStr.startsWith('91') && phoneStr.length > 10) {
        phoneStr = phoneStr.replace(/^91/, '');
    }

    const user = await User.findOne({ phone: phoneStr }).select('+password');
    if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!user.password) {
        return res.status(401).json({ success: false, message: 'Password not set. Please login via OTP and set a password in your profile.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
        expiresIn: '30d'
    });

    // Remove password from output
    user.password = undefined;

    res.status(200).json({
        success: true,
        token,
        isNewUser: !user.firstName,
        user
    });
};

// @desc    Reset Password (via OTP Token)
// @route   POST /api/auth/reset-password
// @access  Private
exports.resetPassword = async (req, res) => {
    // The user must be authenticated via Firebase OTP token first, 
    // which gives them a standard JWT token, or we accept the JWT in header 
    // and just let them update their password like a normal update.
    // However, if they forgot password, they login via OTP, then they are authenticated!
    // So this just needs to take a new password.
    
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ success: false, message: 'Please provide a new password' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await User.findOneAndUpdate(
            { id: req.user.id },
            { $set: { password: hashedPassword } }
        );

        res.status(200).json({
            success: true,
            message: 'Password reset successfully'
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
