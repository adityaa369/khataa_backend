const crypto = require('crypto');
const User = require('../models/User');
const SecurityEvent = require('../models/SecurityEvent');
const { cacheGet, cacheSet, cacheInvalidate } = require('../config/redis');
const { updateCreditScore } = require('../utils/creditScoreCalc');
const {
    validateAadhaarNumber,
    maskAadhaar,
    hashAadhaar,
    checkOtpGenerationAllowed,
    recordOtpDispatched,
    clearUserKycRateLimits,
    requestQuickoAadhaarOtp,
    verifyQuickoAadhaarOtp,
    SANDBOX_TEST_AADHAAR,
    MAX_VERIFY_ATTEMPTS,
    RESEND_COOLDOWN_SEC
} = require('../services/AadhaarKycService');

async function applyVerifiedKycToUser(user, session, kycData, reqIp = 'N/A', reqUrl = '/api/kyc/aadhaar/verify-otp') {
    const finalMasked = kycData.maskedAadhaar || session.maskedAadhaar || 'XXXX-XXXX-Verified';

    user.isVerified = true;
    user.isAadhaarVerified = true;
    user.aadhar = finalMasked;
    user.aadhaarMasked = finalMasked;
    if (session.aadhaarHash) {
        user.aadhaarHash = session.aadhaarHash;
    }
    user.aadhaarVerifiedAt = new Date();
    user.aadhaarKycData = {
        fullName: kycData.fullName || '',
        dob: kycData.dob || '',
        gender: kycData.gender || '',
        careOf: kycData.careOf || '',
        fullAddress: kycData.fullAddress || '',
        district: kycData.district || '',
        state: kycData.state || '',
        pincode: kycData.pincode || '',
        referenceId: kycData.referenceId || session.referenceId || '',
        verificationMode: kycData.verificationMode || session.mode || 'DIGILOCKER',
        photoBase64: kycData.photoBase64 || null
    };
    user.pendingAadhaarSession = undefined;

    // Sync official UIDAI Aadhaar demographic details & photo directly to user profile
    if (kycData.fullName && String(kycData.fullName).trim().isNotEmpty) {
        const nameParts = String(kycData.fullName).trim().split(/\s+/);
        user.firstName = nameParts[0];
        user.lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    }
    if (kycData.fullAddress) {
        user.address = kycData.fullAddress;
    }
    if (kycData.district) {
        user.city = kycData.district;
    }
    if (kycData.gender) {
        user.gender = kycData.gender;
    }
    if (kycData.dob) {
        user.dob = kycData.dob;
    }
    if (kycData.photoBase64 && (!user.profileImageId || user.profileImageId.startsWith('data:image'))) {
        user.profileImageId = kycData.photoBase64;
    }

    await user.save();
    updateCreditScore(user.id).catch(() => {});

    await SecurityEvent.create({
        eventId: crypto.randomUUID(),
        userId: user._id,
        actorType: 'USER',
        actorId: user.id,
        eventType: 'AADHAAR_KYC_VERIFIED',
        severity: 'LOW',
        route: reqUrl,
        result: 'SUCCESS',
        ipReference: reqIp,
        metadata: {
            maskedAadhaar: finalMasked,
            verifiedName: kycData.fullName,
            referenceId: kycData.referenceId,
            verificationMode: kycData.verificationMode
        }
    }).catch(() => {});

    return finalMasked;
}

// @desc    Get current user's Aadhaar eKYC verification status
// @route   GET /api/kyc/aadhaar/status
// @access  Private
exports.getAadhaarKycStatus = async (req, res) => {
    try {
        const user = await User.findOne({ id: req.user.id })
            .select('id firstName lastName isVerified isAadhaarVerified aadhaarMasked aadhaarVerifiedAt aadhaarKycData aadhaarKycData.photoBase64 profileImageId pendingAadhaarSession')
            .lean();

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const lockKey = `kyc:lockout:${req.user.id}`;
        const lockedUntil = await cacheGet(lockKey);
        const isLockedOut = Boolean(lockedUntil && Number(lockedUntil) > Date.now());
        const lockoutRemainingSeconds = isLockedOut
            ? Math.ceil((Number(lockedUntil) - Date.now()) / 1000)
            : 0;

        const kycDetails = user.aadhaarKycData || null;
        const payload = {
            isAadhaarVerified: Boolean(user.isAadhaarVerified),
            aadhaarMasked: user.aadhaarMasked || null,
            aadhaarVerifiedAt: user.aadhaarVerifiedAt || null,
            kycData: kycDetails,
            kycDetails,
            pendingSession:
                user.pendingAadhaarSession &&
                user.pendingAadhaarSession.expiresAt &&
                new Date(user.pendingAadhaarSession.expiresAt) > new Date()
                    ? {
                          referenceId: user.pendingAadhaarSession.referenceId,
                          maskedAadhaar: user.pendingAadhaarSession.maskedAadhaar,
                          mode: user.pendingAadhaarSession.mode,
                          authorizationUrl: user.pendingAadhaarSession.authorizationUrl
                      }
                    : null,
            isLockedOut,
            lockoutRemainingSeconds
        };

        res.status(200).json({
            success: true,
            ...payload,
            data: payload
        });
    } catch (err) {
        res.locals.errorMessage = err.message;
        res.status(500).json({ success: false, message: 'Failed to fetch Aadhaar eKYC status' });
    }
};

// @desc    Step 1: Validate Aadhaar & initiate live UIDAI verification via Quicko (Sandbox.co.in)
// @route   POST /api/kyc/aadhaar/send-otp
// @access  Private
exports.sendAadhaarOtp = async (req, res) => {
    try {
        const { aadhaarNumber, consent } = req.body;

        if (!consent) {
            return res.status(400).json({
                success: false,
                message: 'Explicit UIDAI user consent is required to perform Aadhaar OTP verification.'
            });
        }

        const user = await User.findOne({ id: req.user.id });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.isAadhaarVerified) {
            return res.status(400).json({
                success: false,
                message: `Your account is already verified with Aadhaar (${user.aadhaarMasked || 'Verified'}).`
            });
        }

        // 1. Validate 12-digit format & UIDAI Verhoeff checksum (saves API quota on typos)
        const validation = validateAadhaarNumber(aadhaarNumber);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                message: validation.message
            });
        }

        const cleanAadhaar = validation.clean;
        const aadhaarHash = hashAadhaar(cleanAadhaar);
        const maskedAadhaar = maskAadhaar(cleanAadhaar);
        const last4Digits = cleanAadhaar.slice(-4);

        // 2. Duplicate Identity Prevention (1 Aadhaar = 1 HandCredit Account, except Sandbox Test Aadhaar)
        if (cleanAadhaar !== SANDBOX_TEST_AADHAAR) {
            const existingAccount = await User.findOne({
                aadhaarHash,
                id: { $ne: req.user.id },
                isAadhaarVerified: true
            })
                .select('id')
                .lean();

            if (existingAccount) {
                await SecurityEvent.create({
                    eventId: crypto.randomUUID(),
                    userId: req.user._id,
                    actorType: 'USER',
                    actorId: req.user.id,
                    eventType: 'DUPLICATE_AADHAAR_BLOCKED',
                    severity: 'HIGH',
                    route: req.originalUrl,
                    result: 'BLOCKED',
                    ipReference: req.ip || 'N/A',
                    metadata: { maskedAadhaar }
                }).catch(() => {});

                return res.status(409).json({
                    success: false,
                    message: 'This Aadhaar number is already verified and linked to another HandCredit account.'
                });
            }
        }

        // 3. Multi-layer rate limit & cooldown check
        const rateCheck = await checkOtpGenerationAllowed(req.user.id, aadhaarHash);
        if (!rateCheck.allowed) {
            return res.status(rateCheck.status || 429).json({
                success: false,
                retryAfterSeconds: rateCheck.retryAfterSeconds || 900,
                message: rateCheck.message
            });
        }

        // Build callback URL with userId so callback auto-completes verification
        const baseHost =
            process.env.RENDER_EXTERNAL_URL ||
            process.env.BACKEND_PUBLIC_URL ||
            'https://khataa-backend.onrender.com';
        const redirectUrl = `${baseHost.replace(/\/$/, '')}/api/kyc/aadhaar/callback`;

        // 4. Call Quicko (Sandbox.co.in) Live Aadhaar Session endpoint
        const otpResult = await requestQuickoAadhaarOtp(cleanAadhaar, { redirectUrl });
        if (!otpResult.success) {
            return res.status(otpResult.status || 400).json({
                success: false,
                message: otpResult.message
            });
        }

        // 5. Record session in both Redis/Memory AND MongoDB User document (100% restart/multi-worker resilient)
        await recordOtpDispatched(req.user.id, aadhaarHash, maskedAadhaar, otpResult.referenceId, {
            last4Digits,
            mode: otpResult.mode || 'DIGILOCKER',
            authorizationUrl: otpResult.authorizationUrl || null
        });

        user.pendingAadhaarSession = {
            referenceId: String(otpResult.referenceId),
            aadhaarHash,
            maskedAadhaar,
            last4Digits,
            mode: otpResult.mode || 'DIGILOCKER',
            authorizationUrl: otpResult.authorizationUrl || null,
            attempts: 0,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000)
        };
        await user.save();

        await SecurityEvent.create({
            eventId: crypto.randomUUID(),
            userId: req.user._id,
            actorType: 'USER',
            actorId: req.user.id,
            eventType: 'AADHAAR_OTP_SENT',
            severity: 'LOW',
            route: req.originalUrl,
            result: 'SUCCESS',
            ipReference: req.ip || 'N/A',
            metadata: {
                maskedAadhaar,
                referenceId: otpResult.referenceId,
                mode: otpResult.mode || 'DIGILOCKER'
            }
        }).catch(() => {});

        const responseData = {
            referenceId: otpResult.referenceId,
            mode: otpResult.mode || 'DIGILOCKER',
            authorizationUrl: otpResult.authorizationUrl || null,
            maskedAadhaar,
            aadhaarMasked: maskedAadhaar,
            expiresInSeconds: 1800,
            cooldownSeconds: RESEND_COOLDOWN_SEC,
            remainingAttempts: MAX_VERIFY_ATTEMPTS
        };

        return res.status(200).json({
            success: true,
            ...responseData,
            data: responseData,
            message:
                otpResult.providerMessage ||
                `UIDAI Aadhaar OTP session initiated for ${maskedAadhaar}.`
        });
    } catch (err) {
        console.error('[KYC] sendAadhaarOtp error:', err.message);
        res.locals.errorMessage = err.message;
        return res.status(500).json({
            success: false,
            message: 'Unable to connect to Aadhaar verification gateway. Please try again shortly.'
        });
    }
};

// @desc    Step 2: Verify Aadhaar OTP / Poll UIDAI DigiLocker Session & fetch user details
// @route   POST /api/kyc/aadhaar/verify-otp
// @access  Private
exports.verifyAadhaarOtp = async (req, res) => {
    try {
        const { referenceId, otp } = req.body;
        const cleanOtp = String(otp || '').replace(/\D/g, '');

        const user = await User.findOne({ id: req.user.id });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // If callback already completed verification in the background, return immediate success!
        if (user.isAadhaarVerified && user.aadhaarKycData && user.aadhaarKycData.fullName) {
            const safeKyc = user.aadhaarKycData.toObject ? user.aadhaarKycData.toObject() : { ...user.aadhaarKycData };
            delete safeKyc.photoBase64;
            return res.status(200).json({
                success: true,
                message: 'Aadhaar eKYC verified successfully via UIDAI!',
                aadhaarMasked: user.aadhaarMasked,
                kycData: safeKyc,
                data: {
                    aadhaarMasked: user.aadhaarMasked,
                    verifiedDetails: safeKyc,
                    kycData: safeKyc
                }
            });
        }

        const effectiveRefId = referenceId || user.pendingAadhaarSession?.referenceId;
        if (!effectiveRefId) {
            return res.status(400).json({
                success: false,
                message: 'Valid referenceId is required. Please initiate Aadhaar verification first.'
            });
        }

        const sessionKey = `kyc:session:${effectiveRefId}`;
        let session = await cacheGet(sessionKey);

        // Fallback to MongoDB pendingAadhaarSession if cache was cleared or worker switched
        if (!session && user.pendingAadhaarSession && user.pendingAadhaarSession.referenceId === String(effectiveRefId)) {
            if (!user.pendingAadhaarSession.expiresAt || new Date(user.pendingAadhaarSession.expiresAt) > new Date()) {
                session = {
                    userId: user.id,
                    aadhaarHash: user.pendingAadhaarSession.aadhaarHash,
                    maskedAadhaar: user.pendingAadhaarSession.maskedAadhaar,
                    last4Digits: user.pendingAadhaarSession.last4Digits,
                    referenceId: user.pendingAadhaarSession.referenceId,
                    mode: user.pendingAadhaarSession.mode || 'DIGILOCKER',
                    authorizationUrl: user.pendingAadhaarSession.authorizationUrl,
                    attempts: user.pendingAadhaarSession.attempts || 0
                };
            }
        }

        if (!session || session.userId !== req.user.id) {
            return res.status(400).json({
                success: false,
                message: 'Aadhaar verification session has expired or is invalid. Please start a new session.'
            });
        }

        const isDigiLockerMode = session.mode === 'DIGILOCKER';

        if (!isDigiLockerMode && cleanOtp.length !== 6) {
            return res.status(400).json({
                success: false,
                message: 'Please enter the 6-digit Aadhaar OTP.'
            });
        }

        // Check brute-force attempt limit on OTP mode
        const currentAttempts = (Number(session.attempts) || 0) + (isDigiLockerMode ? 0 : 1);
        if (!isDigiLockerMode && currentAttempts > MAX_VERIFY_ATTEMPTS) {
            await cacheInvalidate(sessionKey);
            const lockExpires = Date.now() + 15 * 60 * 1000;
            await cacheSet(`kyc:lockout:${req.user.id}`, String(lockExpires), 15 * 60);

            return res.status(429).json({
                success: false,
                remainingAttempts: 0,
                message: 'Maximum 3 wrong OTP attempts exceeded. Verification locked for 15 minutes for your security.'
            });
        }

        // Verify via Quicko (DigiLocker XML fetch or Sandbox Test OTP)
        const verifyResult = await verifyQuickoAadhaarOtp(effectiveRefId, cleanOtp, session);

        if (verifyResult.pending) {
            return res.status(202).json({
                success: false,
                pending: true,
                sessionStatus: verifyResult.sessionStatus || 'created',
                authorizationUrl: session.authorizationUrl || null,
                message: verifyResult.message
            });
        }

        if (!verifyResult.success) {
            if (!isDigiLockerMode) {
                const remaining = Math.max(0, MAX_VERIFY_ATTEMPTS - currentAttempts);
                if (remaining === 0) {
                    await cacheInvalidate(sessionKey);
                    const lockExpires = Date.now() + 15 * 60 * 1000;
                    await cacheSet(`kyc:lockout:${req.user.id}`, String(lockExpires), 15 * 60);
                } else {
                    await cacheSet(sessionKey, { ...session, attempts: currentAttempts }, 30 * 60);
                    if (user.pendingAadhaarSession) {
                        user.pendingAadhaarSession.attempts = currentAttempts;
                        await user.save();
                    }
                }

                return res.status(400).json({
                    success: false,
                    remainingAttempts: remaining,
                    message:
                        remaining > 0
                            ? `${verifyResult.message} (${remaining} attempt(s) remaining)`
                            : 'Invalid OTP. Maximum 3 attempts reached — session locked for 15 minutes.'
                });
            }

            return res.status(400).json({
                success: false,
                message: verifyResult.message
            });
        }

        // Success! Clear OTP session immediately
        await cacheInvalidate(sessionKey);

        const kycData = verifyResult.kycData;

        // Secondary duplicate-Aadhaar check at verification stage (1 Aadhaar = 1 HandCredit Account)
        if (session.mode !== 'TEST_OTP') {
            const dupConditions = [];
            if (session.aadhaarHash) {
                dupConditions.push({ aadhaarHash: session.aadhaarHash });
            }
            if (kycData.maskedAadhaar && kycData.dob && kycData.fullName) {
                dupConditions.push({
                    aadhaarMasked: kycData.maskedAadhaar,
                    'aadhaarKycData.dob': kycData.dob,
                    'aadhaarKycData.fullName': kycData.fullName
                });
            }
            if (dupConditions.length > 0) {
                const duplicateOwner = await User.findOne({
                    id: { $ne: req.user.id },
                    isAadhaarVerified: true,
                    $or: dupConditions
                })
                    .select('id')
                    .lean();

                if (duplicateOwner) {
                    return res.status(409).json({
                        success: false,
                        message: 'This Aadhaar identity is already verified and linked to another HandCredit account.'
                    });
                }
            }
        }

        const finalMasked = await applyVerifiedKycToUser(user, session, kycData, req.ip || 'N/A', req.originalUrl);

        const safeKycData = user.aadhaarKycData.toObject
            ? user.aadhaarKycData.toObject()
            : { ...user.aadhaarKycData };

        const userObj = user.toObject();

        return res.status(200).json({
            success: true,
            message: 'Aadhaar eKYC verified successfully via UIDAI!',
            aadhaarMasked: finalMasked,
            kycData: safeKycData,
            user: userObj,
            data: {
                aadhaarMasked: finalMasked,
                verifiedDetails: safeKycData,
                kycData: safeKycData
            }
        });
    } catch (err) {
        console.error('[KYC] verifyAadhaarOtp error:', err.message);
        res.locals.errorMessage = err.message;
        return res.status(500).json({
            success: false,
            message: 'Unable to complete Aadhaar OTP verification. Please try again.'
        });
    }
};

// @desc    Public OAuth Redirect Callback after user completes UIDAI OTP on MeriPehchaan DigiLocker
// @route   GET /api/kyc/aadhaar/callback
// @access  Public
exports.handleDigiLockerCallback = async (req, res) => {
    try {
        // Attempt to auto-complete any active pending DigiLocker session that just succeeded
        const recentUsers = await User.find({
            isAadhaarVerified: { $ne: true },
            'pendingAadhaarSession.referenceId': { $exists: true },
            'pendingAadhaarSession.expiresAt': { $gt: new Date() }
        }).limit(5);

        for (const u of recentUsers) {
            const sess = u.pendingAadhaarSession;
            if (sess && sess.referenceId && sess.mode === 'DIGILOCKER') {
                const verifyResult = await verifyQuickoAadhaarOtp(sess.referenceId, '', sess).catch(() => null);
                if (verifyResult && verifyResult.success && verifyResult.kycData) {
                    await applyVerifiedKycToUser(u, sess, verifyResult.kycData, req.ip || 'N/A', '/api/kyc/aadhaar/callback');
                    await cacheInvalidate(`kyc:session:${sess.referenceId}`);
                }
            }
        }
    } catch (err) {
        console.error('[KYC] Callback background sync error:', err.message);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aadhaar eKYC Completed — HandCredit</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0fdf4; color: #064e3b; display: flex; align-items: center; justify-content: center; min-height: 92vh; margin: 0; padding: 20px; text-align: center; }
    .card { background: #ffffff; border: 2px solid #10b981; border-radius: 18px; padding: 32px 24px; max-width: 400px; box-shadow: 0 12px 30px rgba(16,185,129,0.12); }
    .icon { width: 64px; height: 64px; border-radius: 50%; background: #d1fae5; color: #059669; font-size: 34px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-weight: bold; }
    h1 { font-size: 20px; margin: 0 0 10px; color: #065f46; }
    p { font-size: 14px; color: #374151; line-height: 1.5; margin: 0 0 20px; }
    .pill { display: inline-block; background: #059669; color: #fff; font-weight: 700; font-size: 14px; padding: 12px 22px; border-radius: 10px; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10003;</div>
    <h1>UIDAI Aadhaar Consent Completed!</h1>
    <p>Your official UIDAI Aadhaar details have been securely shared with <strong>HandCredit</strong>. Please close this tab or tap the back button to return to the HandCredit app.</p>
    <div class="pill" onclick="window.close()">Close Window &amp; Return to App</div>
  </div>
</body>
</html>`);
};

// @desc    Reset Aadhaar eKYC on current user (or target user if Admin) for re-testing
// @route   POST /api/kyc/aadhaar/reset
// @access  Private
exports.resetAadhaarKyc = async (req, res) => {
    try {
        const targetUserId = (req.user.isAdmin && req.body?.userId) ? req.body.userId : req.user.id;
        const user = await User.findOne({ id: targetUserId });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const oldHash = user.aadhaarHash;
        const oldRef = user.pendingAadhaarSession?.referenceId;

        user.isAadhaarVerified = false;
        user.aadhaarMasked = undefined;
        user.aadhaarHash = undefined;
        user.aadhaarVerifiedAt = undefined;
        user.aadhaarKycData = undefined;
        user.pendingAadhaarSession = undefined;
        if (user.profileImageId && String(user.profileImageId).startsWith('data:image')) {
            user.profileImageId = undefined;
        }
        await user.save();

        await clearUserKycRateLimits(targetUserId, oldHash);
        if (oldRef) {
            await cacheInvalidate(`kyc:session:${oldRef}`);
        }

        return res.status(200).json({
            success: true,
            message: 'Aadhaar eKYC state and rate-limit counters have been reset. You can now test verification again.'
        });
    } catch (err) {
        res.locals.errorMessage = err.message;
        return res.status(500).json({ success: false, message: 'Failed to reset Aadhaar eKYC state.' });
    }
};
