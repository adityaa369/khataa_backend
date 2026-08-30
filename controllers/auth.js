const jwt = require('jsonwebtoken');
const Session = require('../models/Session');
const SecurityEvent = require('../models/SecurityEvent');

const TokenManager = require('../utils/tokenManager');
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

        // Extract the verified Firebase UID — this is the authoritative identity key
        const verifiedFirebaseUid = result.uid;
        if (!verifiedFirebaseUid) {
            return res.status(400).json({ success: false, message: 'Firebase credential contains no UID' });
        }

        let isNewUser = false;
        // Look up by phone first (existing behavior), but we'll enforce UID cross-check below
        let user = await User.findOne({ phone: phoneStr }).select('+firebaseUid');

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
            // New user — create and bind UID atomically
            const id = crypto.randomUUID();
            user = await User.create({
                id,
                phone: phoneStr,
                isVerified: true,
                firebaseUid: verifiedFirebaseUid,
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
            // Existing user — enforce Firebase UID binding
            if (user.firebaseUid) {
                // UID is already bound — must match exactly
                if (user.firebaseUid !== verifiedFirebaseUid) {
                    // This is the account-rebinding attack: different Firebase UID, same phone.
                    // Could be account deletion+recreation. Reject and require explicit recovery.
                    console.error(`[Auth] Firebase UID mismatch for phone ${phoneStr}: stored=${user.firebaseUid} incoming=${verifiedFirebaseUid}`);
                    return res.status(403).json({
                        success: false,
                        code: 'FIREBASE_UID_MISMATCH',
                        message: 'This phone number is associated with a different Firebase account. Please contact support for account recovery.'
                    });
                }
            } else {
                // Legacy user with no UID yet — bind now on first successful login
                await User.findByIdAndUpdate(user._id, { firebaseUid: verifiedFirebaseUid });
            }

            if (registrationDetails) {
                user = await User.findOneAndUpdate(
                    { phone: phoneStr },
                    { $set: updates },
                    { new: true }
                );
            }
        }


        const tokenData = await TokenManager.createSession(user.id, req.headers['user-agent'], req.ip);
        const token = tokenData.accessToken;
        const refreshToken = tokenData.refreshToken;

        res.status(200).json({
            success: true,
            token, refreshToken, isNewUser: isNewUser || !user.firstName,
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
        let phoneStr = phone.replace(/\D/g, '');
        if (phoneStr.startsWith('91') && phoneStr.length > 10) {
            phoneStr = phoneStr.substring(2);
        }

        const user = await User.findOne({ phone: phoneStr }).select('+password');
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        if (!user.password) {
            return res.status(400).json({ success: false, message: 'No password set for this account. Please use OTP login or register first.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const tokenData = await TokenManager.createSession(user.id, req.headers['user-agent'], req.ip);
        
        res.status(200).json({
            success: true,
            token: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                phone: user.phone,
                email: user.email,
                role: user.role
            }
        });
    } catch (err) {
        console.error('[Auth] loginPassword Error:', err.message);
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
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
        let phoneStr = phone.replace(/\D/g, '');
        if (phoneStr.startsWith('91') && phoneStr.length > 10) {
            phoneStr = phoneStr.substring(2);
        }

        const user = await User.findOne({ phone: phoneStr }).select('+password');
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        if (!user.password) {
            return res.status(400).json({ success: false, message: 'No password set for this account. Please use OTP login or register first.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const tokenData = await TokenManager.createSession(user.id, req.headers['user-agent'], req.ip);
        
        res.status(200).json({
            success: true,
            token: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                phone: user.phone,
                email: user.email,
                role: user.role
            }
        });
    } catch (err) {
        console.error('[Auth] loginPassword Error:', err.message);
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};

// @desc    Send/Resend Verification Email
// @route   POST /api/auth/send-verification-email
// @access  Private
exports.sendVerificationEmail = async (req, res) => {
    try {
        const user = await User.findOne({ id: req.user.id });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        if (user.isEmailVerified) {
            return res.status(400).json({ success: false, message: 'Email is already verified' });
        }
        if (!user.email) {
            return res.status(400).json({ success: false, message: 'No email address found on profile' });
        }

        // Generate new secure random token
        const verifyToken = crypto.randomBytes(20).toString('hex');
        
        // Hash it for secure storage
        const hashedToken = crypto.createHash('sha256').update(verifyToken).digest('hex');
        const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

        user.emailVerificationToken = hashedToken;
        user.emailVerificationExpires = expires;
        await user.save();

        const verifyUrl = `${process.env.BACKEND_URL || 'https://khataa-backend.onrender.com'}/api/auth/verify-email/${verifyToken}`;
        
        await sendEmail({
            to: user.email,
            subject: 'Verify your Khatha email address',
            html: emailVerificationTemplate(
                `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.phone,
                verifyUrl
            )
        });

        res.status(200).json({ success: true, message: 'Verification email sent successfully' });
    } catch (err) {
        console.error('[Auth] sendVerificationEmail error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to send verification email' });
    }
};

// @desc    Verify email address via token link
// @route   GET /api/auth/verify-email/:token
// @access  Public
exports.verifyEmail = async (req, res) => {
    try {
        const { token } = req.params;
        if (!token) return res.status(400).send('<h2>Invalid verification link.</h2>');

        // Hash the incoming raw token to match the database stored hash
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        const user = await User.findOne({
            emailVerificationToken: hashedToken,
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



// @desc    Refresh Access Token using Refresh Token
// @route   POST /api/auth/refresh
// @access  Public
exports.refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });

        const tokenHash = TokenManager.hashRefreshToken(refreshToken);
        const session = await Session.findOne({ refreshTokenHash });

        // 1. REUSE DETECTION: If token doesn't exist, someone might be re-using an old token!
        if (!session) {
            // Realistically, to detect reuse perfectly we'd need a token family tree.
            // For now, if a hash isn't active, we reject.
            return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
        }

        // 2. CHECK EXPIRATION OR REVOCATION
        if (session.revokedAt || new Date() > session.expiresAt) {
            await Session.deleteOne({ _id: session._id }); // Clean it up
            return res.status(401).json({ success: false, message: 'Session expired or revoked' });
        }

        // 3. ROTATION: Invalidate the current session and create a new one (Token Family replacement)
        await Session.deleteOne({ _id: session._id }); // Invalidate old

        const tokenData = await TokenManager.createSession(session.userId, req.headers['user-agent'], req.ip);

        res.status(200).json({
            success: true,
            token: tokenData.accessToken,
            refreshToken: tokenData.refreshToken
        });
    } catch (err) {
        console.error('[Auth] Refresh error:', err.message);
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};

// @desc    Logout (Revoke Session)
// @route   POST /api/auth/logout
// @access  Private
exports.logout = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (refreshToken) {
            const tokenHash = TokenManager.hashRefreshToken(refreshToken);
            await Session.deleteOne({ refreshTokenHash, userId: req.user.id });
        }
        res.status(200).json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};

// @desc    Get all active sessions
// @route   GET /api/auth/sessions
// @access  Private
exports.getSessions = async (req, res) => {
    try {
        const sessions = await Session.find({ userId: req.user.id, revokedAt: null, expiresAt: { $gt: new Date() } })
            .select('-refreshTokenHash'); // Never expose hash
        res.status(200).json({ success: true, sessions });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};

// @desc    Revoke specific session
// @route   DELETE /api/auth/sessions/:sessionId
// @access  Private
exports.revokeSession = async (req, res) => {
    try {
        const session = await Session.findOneAndDelete({ _id: req.params.sessionId, userId: req.user.id });
        if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
        
        await SecurityEvent.create({
            eventId: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            eventType: 'SESSION_REVOKED',
            actorType: 'USER',
            actorId: req.user.id,
            result: 'SUCCESS'
        });

        res.status(200).json({ success: true, message: 'Session revoked' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};
// @desc    Request Password Reset
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res, next) => {
    try {
        let phoneStr = req.body.phone.replace(/\D/g, '');
        if (phoneStr.startsWith('91') && phoneStr.length > 10) phoneStr = phoneStr.substring(2);

        const user = await User.findOne({ phone: phoneStr });
        if (!user) {
            // Anti-enumeration: Return success even if not found
            return res.status(200).json({ success: true, message: 'If the phone number is registered, password reset instructions have been sent.' });
        }

        // Generate robust reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const hash = crypto.createHash('sha256').update(resetToken).digest('hex');

        user.passwordResetToken = hash;
        user.passwordResetExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
        await user.save();

        // In production, an SMS would be sent here containing the reset token.
        // We MUST NOT return the token in the HTTP response to prevent account takeover.
        res.status(200).json({ success: true, message: 'If the phone number is registered, password reset instructions have been sent.' });
    } catch (err) {
        next(err);
    }
};

// @desc    Reset Password
// @route   POST /api/auth/reset-password
// @access  Public
exports.resetPassword = async (req, res) => {
    try {
        const { resetToken, newPassword } = req.body;
        const hash = crypto.createHash('sha256').update(resetToken).digest('hex');

        const user = await User.findOne({
            passwordResetToken: hash,
            passwordResetExpires: { $gt: Date.now() }
        });

        if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });

        // Update password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);

        // SEC-AUTH: Nullify token after single use to prevent replay!
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save();

        // Optional: Revoke all existing sessions to force relogin after password change
        await Session.deleteMany({ userId: user.id });

        res.status(200).json({ success: true, message: 'Password reset successful. All active sessions revoked.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};


// @desc    Revoke all other sessions
// @route   POST /api/auth/sessions/revoke-others
// @access  Private
exports.revokeOtherSessions = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required to identify current session' });

        const tokenHash = TokenManager.hashRefreshToken(refreshToken);
        const currentSession = await Session.findOne({ refreshTokenHash: tokenHash, userId: req.user.id });

        if (!currentSession) {
            return res.status(401).json({ success: false, message: 'Invalid refresh token context' });
        }

        // Revoke all other sessions
        const result = await Session.deleteMany({
            userId: req.user.id,
            _id: { $ne: currentSession._id }
        });

        await SecurityEvent.create({
            eventId: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            eventType: 'ALL_OTHER_SESSIONS_REVOKED',
            actorType: 'USER',
            actorId: req.user.id,
            result: 'SUCCESS'
        });

        res.status(200).json({ success: true, message: `Revoked ${result.deletedCount} other session(s).`, revokedCount: result.deletedCount });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};

// @desc    Get user security events
// @route   GET /api/auth/security-events
// @access  Private
exports.getSecurityEvents = async (req, res) => {
    try {
        // Return only the authenticated user's events, limit to 10.
        // Omit internal identifiers and sensitive data.
        const events = await SecurityEvent.find({ actorId: req.user.id })
            .sort({ createdAt: -1 })
            .limit(10)
            .select('-__v -ipReference -metadata'); 

        res.status(200).json({ success: true, events });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
};
