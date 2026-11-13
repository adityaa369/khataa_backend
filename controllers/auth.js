const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const CreditScore = require('../models/CreditScore');
const Otp = require('../models/Otp');
const { verifyFirebaseToken, sendOtp } = require('../utils/otpProvider');
const crypto = require('crypto');
const { sendEmail } = require('../utils/email');
const { emailVerificationTemplate } = require('../utils/emailTemplates');

function validateAdultDob(dobStr) {
    if (!dobStr || typeof dobStr !== 'string') {
        return { valid: false, message: 'Date of Birth is required (18+ years only).' };
    }
    const trimmed = dobStr.trim();
    let day, month, year;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
        const parts = trimmed.split('/');
        day = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10);
        year = parseInt(parts[2], 10);
    } else {
        const parsed = new Date(trimmed);
        if (isNaN(parsed.getTime())) {
            return { valid: false, message: 'Invalid Date of Birth format. Use DD/MM/YYYY.' };
        }
        day = parsed.getUTCDate();
        month = parsed.getUTCMonth() + 1;
        year = parsed.getUTCFullYear();
    }

    if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) {
        return { valid: false, message: 'Invalid calendar Date of Birth.' };
    }
    const birthDate = new Date(Date.UTC(year, month - 1, day));
    if (
        birthDate.getUTCFullYear() !== year ||
        birthDate.getUTCMonth() !== month - 1 ||
        birthDate.getUTCDate() !== day
    ) {
        return { valid: false, message: 'Invalid calendar Date of Birth.' };
    }

    const now = new Date();
    let age = now.getUTCFullYear() - year;
    const mDiff = (now.getUTCMonth() + 1) - month;
    if (mDiff < 0 || (mDiff === 0 && now.getUTCDate() < day)) {
        age--;
    }
    if (age < 18) {
        return {
            valid: false,
            message: 'Age Restriction (18+ Only): You must be at least 18 years old to use HandCredit under the Indian Contract Act, 1872.'
        };
    }
    if (age > 105) {
        return { valid: false, message: 'Please enter a valid Date of Birth.' };
    }
    return { valid: true, age };
}

function escapeRegex(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// @desc    Pre-check if mobile number or email address is already registered before sending signup OTP
// @route   POST /api/auth/check-availability
// @access  Public
exports.checkAvailability = async (req, res) => {
    try {
        const { phone, email } = req.body || {};

        if (phone) {
            let phoneStr = String(phone).replace(/\D/g, '');
            if (phoneStr.startsWith('91') && phoneStr.length > 10) {
                phoneStr = phoneStr.substring(2);
            }
            const existingPhone = await User.findOne({ phone: phoneStr }).select('id firstName password').lean();
            if (existingPhone && existingPhone.firstName) {
                return res.status(409).json({
                    success: false,
                    field: 'phone',
                    message: 'An account with this mobile number already exists. Please sign in instead.'
                });
            }
        }

        if (email && String(email).trim()) {
            const cleanEmail = String(email).trim().toLowerCase();
            const existingEmail = await User.findOne({
                email: { $regex: new RegExp(`^${escapeRegex(cleanEmail)}$`, 'i') }
            })
                .select('id phone')
                .lean();

            if (existingEmail) {
                return res.status(409).json({
                    success: false,
                    field: 'email',
                    message: 'This email address is already registered with another HandCredit account.'
                });
            }
        }

        return res.status(200).json({
            success: true,
            available: true
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: 'Unable to check account availability right now.'
        });
    }
};

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

        const registrationDetails = req.body.registrationDetails;
        let existingUser = await User.findOne({ phone: phoneStr }).select('+password');

        if (!registrationDetails) {
            if (!existingUser) {
                return res.status(404).json({
                    success: false,
                    message: 'Mobile number is not registered. Please create an account first.'
                });
            }
            if (existingUser.isSuspended) {
                return res.status(403).json({
                    success: false,
                    message: 'Your account has been suspended. Please contact support.'
                });
            }
        } else {
            if (existingUser && existingUser.firstName && existingUser.password) {
                return res.status(400).json({
                    success: false,
                    message: 'An account with this mobile number already exists. Please sign in.'
                });
            }
            if (registrationDetails.email) {
                const cleanEmail = registrationDetails.email.toLowerCase().trim();
                const emailOwner = await User.findOne({
                    email: { $regex: new RegExp(`^${escapeRegex(cleanEmail)}$`, 'i') },
                    phone: { $ne: phoneStr }
                });
                if (emailOwner) {
                    return res.status(400).json({
                        success: false,
                        message: 'This email address is already registered with another account.'
                    });
                }
            }
        }

        const wasRegistered = Boolean(existingUser && existingUser.firstName && existingUser.password);

        let updates = {};
        updates.firebaseUid = result.uid;
        if (registrationDetails) {
            if (registrationDetails.dob !== undefined) {
                const dobCheck = validateAdultDob(registrationDetails.dob);
                if (!dobCheck.valid) {
                    return res.status(400).json({
                        success: false,
                        message: dobCheck.message
                    });
                }
            }
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

        // Atomically find or create the user to prevent duplicate insertions
        let user = await User.findOneAndUpdate(
            { phone: phoneStr },
            { 
                $setOnInsert: {  
                    id: crypto.randomUUID(), 
                    phone: phoneStr, 
                    isVerified: true 
                },
                $set: updates
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // SYNC EMAIL TO FIREBASE (Registration & Repair)
        if (user.email && result.uid) {
            try {
                const admin = require('firebase-admin');
                const fbUser = await admin.auth().getUser(result.uid);
                if (fbUser.email !== user.email) {
                    await admin.auth().updateUser(result.uid, {
                        email: user.email,
                        emailVerified: user.isEmailVerified || false
                    });
                    console.log(`[Auth] Synchronized email for user ${user.id} to Firebase Auth`);
                }
            } catch (err) {
                console.error(`[Auth] Failed to sync email to Firebase for user ${user.id}: ${err.message}`);
            }
        }

        // Ensure legacy users have an id field
        if (!user.id) {
            user.id = crypto.randomUUID();
            await user.save();
        }

        // Check if we need to initialize CreditScore (if new user)
        const existingScore = await CreditScore.findOne({ user: user.id });
        if (!existingScore) {
            await CreditScore.create({ user: user.id });
        }

        // Note: Email verification omission left intact for brevity

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d'
        });

        res.status(200).json({
            success: true,
            token,
            isNewUser: !wasRegistered,
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

    if (req.body.dob !== undefined) {
        const dobCheck = validateAdultDob(req.body.dob);
        if (!dobCheck.valid) {
            return res.status(400).json({ success: false, message: dobCheck.message });
        }
        if (req.user && req.user.dob && req.user.dob.trim() !== '' && req.user.dob !== req.body.dob) {
            return res.status(400).json({
                success: false,
                message: 'Date of Birth is permanently locked after registration for compliance.'
            });
        }
    }

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

        if (updates.email && user.firebaseUid) {
            try {
                const admin = require('firebase-admin');
                await admin.auth().updateUser(user.firebaseUid, {
                    email: updates.email,
                    emailVerified: false
                });
                user.isEmailVerified = false; // Require re-verification
                await user.save();
            } catch (err) {
                console.error(`[Auth] Failed to update Firebase email for user ${user.id}: ${err.message}`);
                // Proceed anyway, but log it
            }
        }

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

        const user = await User.findOne({ phone: phoneStr }).select('+password');
        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid credentials. Mobile number not registered.' });
        }

        if (user.isSuspended) {
            return res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
        }

        if (!user.password) {
            return res.status(400).json({ success: false, message: 'No password set for this account. Please tap Forgot Password to set a password via OTP.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid credentials. Wrong password.' });
        }

        // Remove password hash before serializing user object
        user.password = undefined;

        let customToken = null;
        try {
            const admin = require('firebase-admin');
            let fbUid = user.firebaseUid;
            if (!fbUid) {
                try {
                    const fbUser = await admin.auth().getUserByPhoneNumber(`+91${phoneStr}`);
                    fbUid = fbUser.uid;
                } catch (_) {
                    fbUid = `uid_${user.id}`;
                }
                user.firebaseUid = fbUid;
                await User.updateOne({ _id: user._id }, { $set: { firebaseUid: fbUid } });
            }
            customToken = await admin.auth().createCustomToken(fbUid);

            if (user.email && fbUid) {
                try {
                    const fbUser = await admin.auth().getUser(fbUid);
                    if (fbUser.email !== user.email) {
                        await admin.auth().updateUser(fbUid, {
                            email: user.email,
                            emailVerified: user.isEmailVerified || false
                        });
                    }
                } catch (_) {}
            }
        } catch (fbErr) {
            console.error('[Auth] loginPassword customToken warning:', fbErr.message);
        }

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d'
        });

        res.status(200).json({
            success: true,
            token,
            customToken,
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
        let user = await User.findOne({ phone: phoneStr }).select('+password');

        if (registrationDetails) {
            if (user && user.firstName && user.password) {
                return res.status(400).json({
                    success: false,
                    message: 'An account with this mobile number already exists. Please sign in.'
                });
            }
            if (registrationDetails.email) {
                const cleanEmail = String(registrationDetails.email).toLowerCase().trim();
                const emailOwner = await User.findOne({
                    email: { $regex: new RegExp(`^${escapeRegex(cleanEmail)}$`, 'i') },
                    phone: { $ne: phoneStr }
                });
                if (emailOwner) {
                    return res.status(400).json({
                        success: false,
                        message: 'This email address is already registered with another account.'
                    });
                }
            }
        }

        let updates = {};
        updates.firebaseUid = 'mock_uid_' + phoneStr;
        if (registrationDetails) {
            if (registrationDetails.dob !== undefined) {
                const dobCheck = validateAdultDob(registrationDetails.dob);
                if (!dobCheck.valid) {
                    return res.status(400).json({
                        success: false,
                        message: dobCheck.message
                    });
                }
            }
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
        } else {
            user = await User.findOneAndUpdate(
                { phone: phoneStr },
                { $set: updates },
                { new: true }
            );
        }

        // Ensure legacy users have an id field
        if (!user.id) {
            user.id = crypto.randomUUID();
            await user.save();
        }

        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d'
        });

        res.status(200).json({
            success: true,
            token,
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

        const user = await User.findOne({ phone: phoneStr }).select('+password');
        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid credentials. Mobile number not registered.' });
        }

        if (user.isSuspended) {
            return res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
        }

        if (!user.password) {
            return res.status(400).json({ success: false, message: 'No password set for this account. Please tap Forgot Password to set a password via OTP.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid credentials. Wrong password.' });
        }

        // Remove password hash before serializing user object
        user.password = undefined;

        let customToken = null;
        try {
            const admin = require('firebase-admin');
            let fbUid = user.firebaseUid;
            if (!fbUid) {
                try {
                    const fbUser = await admin.auth().getUserByPhoneNumber(`+91${phoneStr}`);
                    fbUid = fbUser.uid;
                } catch (_) {
                    fbUid = `uid_${user.id}`;
                }
                user.firebaseUid = fbUid;
                await User.updateOne({ _id: user._id }, { $set: { firebaseUid: fbUid } });
            }
            customToken = await admin.auth().createCustomToken(fbUid);

            if (user.email && fbUid) {
                try {
                    const fbUser = await admin.auth().getUser(fbUid);
                    if (fbUser.email !== user.email) {
                        await admin.auth().updateUser(fbUid, {
                            email: user.email,
                            emailVerified: user.isEmailVerified || false
                        });
                    }
                } catch (_) {}
            }
        } catch (fbErr) {
            console.error('[Auth] loginPassword customToken warning:', fbErr.message);
        }

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d'
        });

        res.status(200).json({
            success: true,
            token,
            customToken,
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
        let user = await User.findOne({ phone: phoneStr }).select('+password');

        if (registrationDetails) {
            if (user && user.firstName && user.password) {
                return res.status(400).json({
                    success: false,
                    message: 'An account with this mobile number already exists. Please sign in.'
                });
            }
            if (registrationDetails.email) {
                const cleanEmail = String(registrationDetails.email).toLowerCase().trim();
                const emailOwner = await User.findOne({
                    email: { $regex: new RegExp(`^${escapeRegex(cleanEmail)}$`, 'i') },
                    phone: { $ne: phoneStr }
                });
                if (emailOwner) {
                    return res.status(400).json({
                        success: false,
                        message: 'This email address is already registered with another account.'
                    });
                }
            }
        }

        let updates = {};
        updates.firebaseUid = 'mock_uid_' + phoneStr;
        if (registrationDetails) {
            if (registrationDetails.dob !== undefined) {
                const dobCheck = validateAdultDob(registrationDetails.dob);
                if (!dobCheck.valid) {
                    return res.status(400).json({
                        success: false,
                        message: dobCheck.message
                    });
                }
            }
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

        // Ensure legacy users have an id field
        if (!user.id) {
            user.id = crypto.randomUUID();
            await user.save();
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
        console.error('[Auth] verifyOtpMsg91 Error:');
        console.error(`Name: ${err.name}`);
        console.error(`Message: ${err.message}`);
        console.error(`Stack: ${err.stack}`);
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


const MPinCredential = require('../models/MPinCredential');
const { getRedisClient } = require('../config/redis');

// @desc    Set up MPIN for the authenticated user
// @route   POST /api/auth/mpin/setup
// @access  Private
exports.setupMpin = async (req, res) => {
    const { mpin } = req.body;
    if (!mpin || mpin.length !== 6) {
        return res.status(400).json({ success: false, message: 'Invalid MPIN' });
    }
    try {
        const salt = await bcrypt.genSalt(12);
        const hash = await bcrypt.hash(mpin, salt);
        
        await MPinCredential.findOneAndUpdate(
            { userId: req.user._id },
            { 
                userId: req.user._id,
                firebaseUid: req.user.firebaseUid || ('mock_uid_' + req.user.phone),
                mpinHash: hash,
                failedAttempts: 0,
                lockoutUntil: null
            },
            { upsert: true, new: true }
        );

        const redisClient = getRedisClient();
        if (redisClient) {
            await redisClient.del(`mpin_attempts:${req.user.id}`);
        }

        res.status(200).json({ success: true, message: 'MPIN setup successful' });
    } catch (err) {
        console.error('[Auth] setupMpin error:', err.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Verify MPIN and return Custom Firebase Token
// @route   POST /api/auth/mpin/verify
// @access  Public
exports.verifyMpin = async (req, res) => {
    const { phone, mpin } = req.body;
    if (!phone || !mpin) {
        return res.status(400).json({ success: false, message: 'Phone and MPIN required' });
    }

    try {
        let phoneStr = phone.toString().replace(/\D/g, '');
        if (phoneStr.startsWith('91') && phoneStr.length > 10) {
            phoneStr = phoneStr.substring(2);
        }

        const user = await User.findOne({ phone: phoneStr });
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid MPIN' });
        }

        if (user.isSuspended) {
            return res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
        }

        const mpinCred = await MPinCredential.findOne({ userId: user._id });
        if (!mpinCred) {
            return res.status(401).json({ success: false, message: 'MPIN is not set up for this account. Please sign in with your password first.' });
        }

        const redisClient = getRedisClient();
        const rateLimitKey = `mpin_attempts:${user._id}`;

        if (redisClient) {
            const currentAttempts = await redisClient.get(rateLimitKey);
            if (currentAttempts && parseInt(currentAttempts) >= 5) {
                return res.status(429).json({ success: false, message: 'Too many failed attempts. Account locked for 15 minutes.' });
            }
        } else {
            if (mpinCred.lockoutUntil && mpinCred.lockoutUntil > new Date()) {
                return res.status(429).json({ success: false, message: 'Too many failed attempts. Account locked for 15 minutes.' });
            } else if (mpinCred.lockoutUntil && mpinCred.lockoutUntil <= new Date()) {
                mpinCred.failedAttempts = 0;
                mpinCred.lockoutUntil = null;
            }
        }

        const isMatch = await bcrypt.compare(mpin, mpinCred.mpinHash);

        if (!isMatch) {
            if (redisClient) {
                const attempts = await redisClient.incr(rateLimitKey);
                if (attempts === 1) {
                    await redisClient.expire(rateLimitKey, 15 * 60);
                }
                if (attempts >= 5) {
                    return res.status(429).json({ success: false, message: 'Too many failed attempts. Account locked for 15 minutes.' });
                }
            } else {
                mpinCred.failedAttempts = (mpinCred.failedAttempts || 0) + 1;
                if (mpinCred.failedAttempts >= 5) {
                    mpinCred.lockoutUntil = new Date(Date.now() + 15 * 60 * 1000);
                    await mpinCred.save();
                    return res.status(429).json({ success: false, message: 'Too many failed attempts. Account locked for 15 minutes.' });
                }
                await mpinCred.save();
            }
            return res.status(401).json({ success: false, message: 'Invalid MPIN' });
        }

        if (redisClient) {
            await redisClient.del(rateLimitKey);
        } else if (mpinCred.failedAttempts > 0 || mpinCred.lockoutUntil) {
            mpinCred.failedAttempts = 0;
            mpinCred.lockoutUntil = null;
            await mpinCred.save();
        }

        let customToken = null;
        try {
            const admin = require('firebase-admin');
            const targetUid = mpinCred.firebaseUid || user.firebaseUid || `uid_${user.id}`;
            customToken = await admin.auth().createCustomToken(targetUid);

            // SYNC EMAIL TO FIREBASE (self-heal on every MPIN login)
            if (user.email && targetUid) {
                try {
                    const fbUser = await admin.auth().getUser(targetUid);
                    if (fbUser.email !== user.email) {
                        await admin.auth().updateUser(targetUid, {
                            email: user.email,
                            emailVerified: user.isEmailVerified || false
                        });
                        console.log(`[Auth] verifyMpin: synced email to Firebase for user ${user.id}`);
                    }
                } catch (syncErr) {
                    console.error(`[Auth] verifyMpin: email sync failed for user ${user.id}: ${syncErr.message}`);
                }
            }
        } catch (fbErr) {
            console.error('[Auth] verifyMpin customToken warning:', fbErr.message);
        }

        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d'
        });

        res.status(200).json({ success: true, customToken, token, user });
    } catch (err) {
        console.error('[Auth] verifyMpin error:', err.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Reset password for authenticated user (after OTP verification)
// @route   POST /api/auth/reset-password
// @access  Private
exports.resetPassword = async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        await User.findOneAndUpdate(
            { id: req.user.id },
            { $set: { password: hashedPassword } }
        );
        res.status(200).json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        console.error('[Auth] resetPassword error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get MPIN status for authenticated user
// @route   GET /api/auth/mpin/status
// @access  Private
exports.getMpinStatus = async (req, res) => {
    try {
        const MPinCredential = require('../models/MPinCredential');
        const cred = await MPinCredential.findOne({ userId: req.user._id });
        res.status(200).json({ success: true, hasMpin: !!cred });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Get active sessions for current user
// @route   GET /api/auth/sessions
// @access  Private
exports.getSessions = async (req, res) => {
    try {
        // We don't have a full session DB yet — return the current device as the only session
        const deviceInfo = req.headers['user-agent'] || 'Unknown Device';
        const session = {
            id: req.user.id + '_session',
            deviceInfo: deviceInfo.substring(0, 80),
            isCurrent: true,
            lastUsedAt: new Date().toISOString(),
        };
        res.status(200).json({ success: true, sessions: [session] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Get security events for current user
// @route   GET /api/auth/security-events
// @access  Private
exports.getSecurityEvents = async (req, res) => {
    try {
        const SecurityEvent = require('../models/SecurityEvent');
        const events = await SecurityEvent.find({
            $or: [
                { actorId: req.user.id },
                { userId: req.user._id }
            ]
        })
            .sort({ createdAt: -1 })
            .limit(25)
            .lean();

        res.status(200).json({ success: true, events });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Revoke a session
// @route   DELETE /api/auth/sessions/:sessionId
// @access  Private
exports.revokeSession = async (req, res) => {
    // Placeholder — for now just return success
    res.status(200).json({ success: true, message: 'Session revoked' });
};

// @desc    Revoke all other sessions
// @route   POST /api/auth/sessions/revoke-others
// @access  Private
exports.revokeOtherSessions = async (req, res) => {
    // Placeholder — for now just return success
    res.status(200).json({ success: true, message: 'Other sessions revoked' });
};

// @desc    Generate a custom token for the authenticated user to re-authenticate with Firebase
// @route   GET /api/auth/firebase-custom-token
// @access  Private
exports.getFirebaseCustomToken = async (req, res) => {
    try {
        const firebaseUid = req.user.firebaseUid;
        
        if (!firebaseUid) {
            return res.status(404).json({ success: false, message: 'Firebase UID not found for user.' });
        }
        
        const admin = require('firebase-admin');
        const customToken = await admin.auth().createCustomToken(firebaseUid);
        res.status(200).json({ success: true, customToken });
    } catch (err) {
        console.error('[Auth] Error generating custom token:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};


// @desc    Sync Firebase State to HandCredit DB
// @route   POST /api/auth/sync-firebase
// @access  Private
exports.syncFirebaseState = async (req, res) => {
    try {
        const { emailVerified, email, idToken } = req.body;
        const User = require('../models/User');
        const user = await User.findOne({ id: req.user.id });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        let verifiedFromFirebase = null;
        let emailFromFirebase = null;
        if (idToken) {
            try {
                const admin = require('firebase-admin');
                const decoded = await admin.auth().verifyIdToken(idToken);
                if (decoded) {
                    verifiedFromFirebase = Boolean(decoded.email_verified);
                    if (decoded.email) emailFromFirebase = decoded.email;
                }
            } catch (_) {}
        }
        if (verifiedFromFirebase === null && user.firebaseUid && !user.firebaseUid.startsWith('mock_uid_')) {
            try {
                const admin = require('firebase-admin');
                const fbUser = await admin.auth().getUser(user.firebaseUid);
                if (fbUser) {
                    verifiedFromFirebase = Boolean(fbUser.emailVerified);
                    if (fbUser.email) emailFromFirebase = fbUser.email;
                }
            } catch (_) {}
        }

        if (verifiedFromFirebase !== null) {
            user.isEmailVerified = verifiedFromFirebase || Boolean(emailVerified);
        } else if (emailVerified !== undefined) {
            user.isEmailVerified = Boolean(emailVerified);
        }
        if (emailFromFirebase || email) {
            user.email = emailFromFirebase || email;
        }
        
        await user.save();
        res.status(200).json({ success: true, message: 'Firebase state synced', user });
    } catch (err) {
        console.error('[Auth] Error syncing firebase state:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Sync Mongo email to Firebase Auth (repair missing Firebase email)
// @route   POST /api/auth/sync-email-to-firebase
// @access  Private
exports.syncEmailToFirebase = async (req, res) => {
    try {
        const User = require('../models/User');
        const user = await User.findOne({ id: req.user.id });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        if (!user.email) {
            return res.status(400).json({ success: false, message: 'No email in user profile' });
        }
        
        if (!user.firebaseUid) {
            return res.status(400).json({ success: false, message: 'No Firebase UID linked' });
        }
        
        const admin = require('firebase-admin');
        const fbUser = await admin.auth().getUser(user.firebaseUid);
        
        if (fbUser.email === user.email) {
            return res.status(200).json({ success: true, message: 'Already synced', email: user.email });
        }
        
        await admin.auth().updateUser(user.firebaseUid, {
            email: user.email,
            emailVerified: user.isEmailVerified || false
        });
        
        console.log(`[Auth] syncEmailToFirebase: attached email for user ${user.id}`);
        res.status(200).json({ success: true, message: 'Email synced to Firebase', email: user.email });
    } catch (err) {
        console.error('[Auth] syncEmailToFirebase error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
exports.updateProfile = async (req, res, next) => {
    try {
        const fieldsToUpdate = {};
        if (req.body.profileImageId !== undefined) fieldsToUpdate.profileImageId = req.body.profileImageId;
        
        // Only allow updating profileImageId for now, expand if needed
        const user = await User.findOneAndUpdate(
            { id: req.user.id },
            fieldsToUpdate,
            { new: true, runValidators: true }
        );

        res.status(200).json({
            success: true,
            data: user
        });
    } catch (err) {
        console.error('Update Profile error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.changeMpin = async (req, res) => {
    const { mpin } = req.body;
    if (!mpin || mpin.length !== 6) {
        return res.status(400).json({ success: false, message: 'Invalid MPIN' });
    }
    try {
        const bcrypt = require('bcryptjs');
        const MPinCredential = require('../models/MPinCredential');
        const salt = await bcrypt.genSalt(12);
        const hash = await bcrypt.hash(mpin, salt);
        
        await MPinCredential.findOneAndUpdate(
            { userId: req.user._id },
            { 
                userId: req.user._id,
                firebaseUid: req.user.firebaseUid || ('mock_uid_' + req.user.phone),
                mpinHash: hash,
                failedAttempts: 0,
                lockoutUntil: null
            },
            { upsert: true, new: true }
        );

        const { cacheInvalidate } = require('../config/redis');
        await cacheInvalidate('mpin_attempts:' + req.user.id);

        const SecurityEvent = require('../models/SecurityEvent');
        await SecurityEvent.create({
            eventId: crypto.randomUUID(),
            userId: req.user._id,
            actorType: 'USER',
            actorId: req.user.id,
            eventType: 'MPIN_CHANGED',
            severity: 'MEDIUM',
            route: req.originalUrl || '/api/auth/mpin/change',
            result: 'SUCCESS',
            ipReference: req.ip || 'N/A',
            userAgent: req.headers['user-agent'] || 'Unknown'
        });

        res.status(200).json({ success: true, message: 'MPIN changed successfully' });
    } catch (err) {
        console.error('[Auth] changeMpin error:', err.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Delete user account and personal data (Google Play Policy & DPDP Act 2023)
// @route   DELETE /api/auth/account
// @access  Private
exports.deleteAccount = async (req, res) => {
    try {
        const Loan = require('../models/Loan');
        const MPinCredential = require('../models/MPinCredential');
        const SecurityEvent = require('../models/SecurityEvent');

        // Safety check: block deletion if user has active or pending credit obligations
        const activeCreditsCount = await Loan.countDocuments({
            $or: [{ lender: req.user.id }, { borrower: req.user.id }],
            status: { $in: ['active', 'pending', 'pending_otp'] }
        });

        if (activeCreditsCount > 0) {
            return res.status(400).json({
                success: false,
                message: 'You have active or pending credit agreements. Please settle and close all active credits before deleting your account.'
            });
        }

        // Remove credentials, score, and security events
        await MPinCredential.deleteMany({ userId: req.user._id });
        await CreditScore.deleteMany({ user: req.user.id });
        await SecurityEvent.deleteMany({ userId: req.user._id });

        // Delete Firebase Auth user if linked
        if (req.user.firebaseUid && !req.user.firebaseUid.startsWith('mock_uid_')) {
            try {
                const admin = require('firebase-admin');
                await admin.auth().deleteUser(req.user.firebaseUid);
            } catch (fbErr) {
                console.warn('[Auth] deleteAccount Firebase user delete warning:', fbErr.message);
            }
        }

        await User.deleteOne({ _id: req.user._id });

        res.status(200).json({
            success: true,
            message: 'Your HandCredit account and personal data have been permanently deleted.'
        });
    } catch (err) {
        console.error('[Auth] deleteAccount error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to delete account. Please try again.' });
    }
};

