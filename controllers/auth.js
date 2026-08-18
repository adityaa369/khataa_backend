const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const CreditScore = require('../models/CreditScore');
const Otp = require('../models/Otp');
const { verifyFirebaseToken, sendOtp } = require('../utils/otpProvider');
const crypto = require('crypto');
const { sendEmail } = require('../utils/email');
const { emailVerificationTemplate } = require('../utils/emailTemplates');

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
            const id = crypto.randomUUID();
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

            // Send email verification if email provided
            if (user.email) {
                try {
                    const verifyToken = crypto.randomBytes(32).toString('hex');
                    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
                    await User.findByIdAndUpdate(user._id, {
                        emailVerificationToken: verifyToken,
                        emailVerificationExpires: expires
                    });
                    const verifyUrl = `${process.env.BACKEND_URL || 'https://khataa-backend.onrender.com'}/api/auth/verify-email/${verifyToken}`;
                    await sendEmail({
                        to: user.email,
                        subject: 'Verify your Khatha email address',
                        html: emailVerificationTemplate(
                            `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.phone,
                            verifyUrl
                        )
                    });
                } catch (emailErr) {
                    console.error('[Auth] Failed to send verification email:', emailErr.message);
                }
            }
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
        if (!otpRecord || otpRecord.code !== otp) {
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
            const id = crypto.randomUUID();
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

            // Send email verification if email provided
            if (user.email) {
                try {
                    const verifyToken = crypto.randomBytes(32).toString('hex');
                    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
                    await User.findByIdAndUpdate(user._id, {
                        emailVerificationToken: verifyToken,
                        emailVerificationExpires: expires
                    });
                    const verifyUrl = `${process.env.BACKEND_URL || 'https://khataa-backend.onrender.com'}/api/auth/verify-email/${verifyToken}`;
                    await sendEmail({
                        to: user.email,
                        subject: 'Verify your Khatha email address',
                        html: emailVerificationTemplate(
                            `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.phone,
                            verifyUrl
                        )
                    });
                } catch (emailErr) {
                    console.error('[Auth] Failed to send verification email:', emailErr.message);
                }
            }
        } else if (registrationDetails) {
            user = await User.findOneAndUpdate(
                { phone: phoneStr },
                { $set: updates },
                { new: true }
            );
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
        if (!otpRecord || otpRecord.code !== otp) {
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
            const id = crypto.randomUUID();
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

            // Send email verification if email provided
            if (user.email) {
                try {
                    const verifyToken = crypto.randomBytes(32).toString('hex');
                    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
                    await User.findByIdAndUpdate(user._id, {
                        emailVerificationToken: verifyToken,
                        emailVerificationExpires: expires
                    });
                    const verifyUrl = `${process.env.BACKEND_URL || 'https://khataa-backend.onrender.com'}/api/auth/verify-email/${verifyToken}`;
                    await sendEmail({
                        to: user.email,
                        subject: 'Verify your Khatha email address',
                        html: emailVerificationTemplate(
                            `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.phone,
                            verifyUrl
                        )
                    });
                } catch (emailErr) {
                    console.error('[Auth] Failed to send verification email:', emailErr.message);
                }
            }
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

// @desc    Verify email address via token link
// @route   GET /api/auth/verify-email/:token
// @access  Public
exports.verifyEmail = async (req, res) => {
    try {
        const { token } = req.params;
        if (!token) return res.status(400).send('<h2>Invalid verification link.</h2>');

        const user = await User.findOne({
            emailVerificationToken: token,
            emailVerificationExpires: { $gt: Date.now() }
        }).select('+emailVerificationToken +emailVerificationExpires');

        if (!user) {
            return res.status(400).send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2 style="color:#dc2626">&#10007; Link expired or invalid</h2>
                <p>Please request a new verification email from the Khatha app.</p>
                </body></html>
            `);
        }

        user.isEmailVerified = true;
        user.emailVerificationToken = undefined;
        user.emailVerificationExpires = undefined;
        await user.save();

        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4">
            <div style="max-width:400px;margin:auto;background:white;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
            <div style="font-size:48px">&#10003;</div>
            <h2 style="color:#059669">Email Verified!</h2>
            <p style="color:#6b7280">Your Khatha account email has been verified. You can now close this window and return to the app.</p>
            </div></body></html>
        `);
    } catch (err) {
        console.error('[Auth] verifyEmail error:', err.message);
        res.status(500).send('<h2>Something went wrong. Please try again.</h2>');
    }
};
