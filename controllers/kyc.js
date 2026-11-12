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
    requestQuickoAadhaarOtp,
    verifyQuickoAadhaarOtp,
    MAX_VERIFY_ATTEMPTS,
    RESEND_COOLDOWN_SEC
} = require('../services/AadhaarKycService');

// @desc    Get current user's Aadhaar eKYC verification status
// @route   GET /api/kyc/aadhaar/status
// @access  Private
exports.getAadhaarKycStatus = async (req, res) => {
    try {
        const user = await User.findOne({ id: req.user.id })
            .select('id firstName lastName isVerified isAadhaarVerified aadhaarMasked aadhaarVerifiedAt aadhaarKycData')
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

        res.status(200).json({
            success: true,
            isAadhaarVerified: Boolean(user.isAadhaarVerified),
            aadhaarMasked: user.aadhaarMasked || null,
            aadhaarVerifiedAt: user.aadhaarVerifiedAt || null,
            kycData: user.aadhaarKycData || null,
            isLockedOut,
            lockoutRemainingSeconds
        });
    } catch (err) {
        res.locals.errorMessage = err.message;
        res.status(500).json({ success: false, message: 'Failed to fetch Aadhaar eKYC status' });
    }
};

// @desc    Step 1: Validate Aadhaar & trigger real UIDAI OTP via Quicko (Sandbox.co.in)
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

        // 2. Duplicate Identity Prevention (1 Aadhaar = 1 HandCredit Account)
        const existingAccount = await User.findOne({
            aadhaarHash,
            id: { $ne: req.user.id },
            isAadhaarVerified: true
        }).select('id').lean();

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

        // 3. Multi-layer rate limit & cooldown check
        const rateCheck = await checkOtpGenerationAllowed(req.user.id, aadhaarHash);
        if (!rateCheck.allowed) {
            return res.status(rateCheck.status || 429).json({
                success: false,
                retryAfterSeconds: rateCheck.retryAfterSeconds || 900,
                message: rateCheck.message
            });
        }

        // 4. Call Quicko (Sandbox.co.in) Live Aadhaar OKYC OTP endpoint
        const otpResult = await requestQuickoAadhaarOtp(cleanAadhaar);
        if (!otpResult.success) {
            return res.status(otpResult.status || 400).json({
                success: false,
                message: otpResult.message
            });
        }

        // 5. Record OTP dispatch & create 10-min verification session
        await recordOtpDispatched(req.user.id, aadhaarHash, maskedAadhaar, otpResult.referenceId);

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
                referenceId: otpResult.referenceId
            }
        }).catch(() => {});

        return res.status(200).json({
            success: true,
            referenceId: otpResult.referenceId,
            maskedAadhaar,
            expiresInSeconds: 600,
            cooldownSeconds: RESEND_COOLDOWN_SEC,
            remainingAttempts: MAX_VERIFY_ATTEMPTS,
            message: otpResult.providerMessage || `A 6-digit OTP has been sent by UIDAI to the mobile number linked with Aadhaar ${maskedAadhaar}.`
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

// @desc    Step 2: Verify 6-digit Aadhaar OTP & fetch UIDAI user details
// @route   POST /api/kyc/aadhaar/verify-otp
// @access  Private
exports.verifyAadhaarOtp = async (req, res) => {
    try {
        const { referenceId, otp } = req.body;
        const cleanOtp = String(otp || '').replace(/\D/g, '');

        if (!referenceId || cleanOtp.length !== 6) {
            return res.status(400).json({
                success: false,
                message: 'Valid referenceId and 6-digit Aadhaar OTP are required.'
            });
        }

        const sessionKey = `kyc:session:${referenceId}`;
        const session = await cacheGet(sessionKey);

        if (!session || session.userId !== req.user.id) {
            return res.status(400).json({
                success: false,
                message: 'Aadhaar OTP session has expired or is invalid. Please request a new OTP.'
            });
        }

        // Check brute-force attempt limit on this referenceId
        const currentAttempts = (Number(session.attempts) || 0) + 1;
        if (currentAttempts > MAX_VERIFY_ATTEMPTS) {
            await cacheInvalidate(sessionKey);
            const lockExpires = Date.now() + 15 * 60 * 1000;
            await cacheSet(`kyc:lockout:${req.user.id}`, String(lockExpires), 15 * 60);

            await SecurityEvent.create({
                eventId: crypto.randomUUID(),
                userId: req.user._id,
                actorType: 'USER',
                actorId: req.user.id,
                eventType: 'AADHAAR_OTP_BRUTE_FORCE_BLOCKED',
                severity: 'HIGH',
                route: req.originalUrl,
                result: 'BLOCKED',
                ipReference: req.ip || 'N/A',
                metadata: { referenceId, attempts: currentAttempts }
            }).catch(() => {});

            return res.status(429).json({
                success: false,
                remainingAttempts: 0,
                message: 'Maximum 3 wrong OTP attempts exceeded. Verification locked for 15 minutes for your security.'
            });
        }

        // Call Quicko (Sandbox.co.in) Verify OTP endpoint
        const verifyResult = await verifyQuickoAadhaarOtp(referenceId, cleanOtp);

        if (!verifyResult.success) {
            const remaining = Math.max(0, MAX_VERIFY_ATTEMPTS - currentAttempts);
            if (remaining === 0) {
                await cacheInvalidate(sessionKey);
                const lockExpires = Date.now() + 15 * 60 * 1000;
                await cacheSet(`kyc:lockout:${req.user.id}`, String(lockExpires), 15 * 60);
            } else {
                await cacheSet(sessionKey, { ...session, attempts: currentAttempts }, 10 * 60);
            }

            return res.status(400).json({
                success: false,
                remainingAttempts: remaining,
                message: remaining > 0
                    ? `${verifyResult.message} (${remaining} attempt(s) remaining)`
                    : 'Invalid OTP. Maximum 3 attempts reached — session locked for 15 minutes.'
            });
        }

        // Success! Clear OTP session immediately (prevent OTP replay)
        await cacheInvalidate(sessionKey);

        const kycData = verifyResult.kycData;
        const user = await User.findOne({ id: req.user.id });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Update user with UIDAI-compliant masked Aadhaar & verified demographic data
        user.isVerified = true;
        user.isAadhaarVerified = true;
        user.aadhar = session.maskedAadhaar;
        user.aadhaarMasked = session.maskedAadhaar;
        user.aadhaarHash = session.aadhaarHash;
        user.aadhaarVerifiedAt = new Date();
        user.aadhaarKycData = {
            fullName: kycData.fullName,
            dob: kycData.dob,
            gender: kycData.gender,
            careOf: kycData.careOf,
            fullAddress: kycData.fullAddress,
            district: kycData.district,
            state: kycData.state,
            pincode: kycData.pincode,
            referenceId: kycData.referenceId,
            photoBase64: kycData.photoBase64
        };

        // Enrich empty profile fields from verified Aadhaar record
        if (!user.address && kycData.fullAddress) {
            user.address = kycData.fullAddress;
        }
        if (!user.city && kycData.district) {
            user.city = kycData.district;
        }
        if (!user.gender && kycData.gender) {
            user.gender = kycData.gender;
        }

        await user.save();

        // Update user's Credit / Trust score asynchronously
        updateCreditScore(user.id).catch(() => {});

        await SecurityEvent.create({
            eventId: crypto.randomUUID(),
            userId: req.user._id,
            actorType: 'USER',
            actorId: req.user.id,
            eventType: 'AADHAAR_KYC_VERIFIED',
            severity: 'LOW',
            route: req.originalUrl,
            result: 'SUCCESS',
            ipReference: req.ip || 'N/A',
            metadata: {
                maskedAadhaar: session.maskedAadhaar,
                verifiedName: kycData.fullName,
                referenceId: kycData.referenceId
            }
        }).catch(() => {});

        const safeKycData = { ...user.aadhaarKycData.toObject() };
        delete safeKycData.photoBase64;

        const userObj = user.toObject();
        if (userObj.aadhaarKycData) {
            delete userObj.aadhaarKycData.photoBase64;
        }

        return res.status(200).json({
            success: true,
            message: 'Aadhaar eKYC verified successfully via UIDAI.',
            aadhaarMasked: session.maskedAadhaar,
            kycData: safeKycData,
            user: userObj
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
