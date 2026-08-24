const OtpChallenge = require('../models/OtpChallenge');
const axios = require('axios');
const { triggerAlert } = require('../utils/telemetry');

class OtpService {
    /**
     * Verifies Firebase OTP directly via Identity Toolkit API.
     * Enforces strict atomic challenge consumption, replay protection, and purpose binding.
     */
    static async verifyAndConsume({ verificationId, otp, userId, purpose, resourceId = null, expectedAmountPaise = null }) {
        if (!verificationId || !otp) {
            throw new Error('VALIDATION_ERROR: Missing OTP or Verification ID');
        }

        // 1. Atomic Replay & Concurrency Protection
        // By inserting the verificationId immediately as a CONSUMED challenge, 
        // we guarantee no two concurrent requests can process the same Firebase OTP session.
        try {
            await OtpChallenge.create({
                challengeId: verificationId,
                userId: userId,
                purpose: purpose,
                resourceId: resourceId,
                expectedAmountPaise: expectedAmountPaise,
                status: 'CONSUMED' // Optimistically lock it
            });
        } catch (err) {
            if (err.code === 11000) {
                // Duplicate key -> The verificationId was already used or is currently processing!
                const existing = await OtpChallenge.findOne({ challengeId: verificationId });
                if (existing && existing.purpose !== purpose) {
                    triggerAlert('OTP_PURPOSE_MISMATCH', 'HIGH', { userId, purpose, resourceId, expectedAmountPaise });
                    throw new Error('OTP_PURPOSE_MISMATCH');
                }
                triggerAlert('OTP_REPLAY', 'HIGH', { userId, purpose, resourceId, expectedAmountPaise });
                throw new Error('OTP_REPLAY_REJECTED');
            }
            throw err;
        }

        // 2. Firebase Authority Verification
        const apiKey = process.env.FIREBASE_API_KEY;
        if (!apiKey) {
            throw new Error('SERVER_CONFIG_ERROR');
        }

        const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=${apiKey}`;
        
        try {
            const response = await axios.post(url, {
                sessionInfo: verificationId,
                code: otp
            });

            if (response.status === 200 && response.data && response.data.phoneNumber) {
                // Success! The challenge remains CONSUMED and valid.
                let phone = response.data.phoneNumber.replace(/\D/g, '');
                if (phone.startsWith('91') && phone.length > 10) phone = phone.substring(2);
                
                return { success: true, phone };
            }
            
            throw new Error('INVALID_OTP');
        } catch (err) {
            // Firebase rejected it (Wrong OTP, Expired, Too Many Attempts)
            // Mark the challenge as FAILED so audit logs reflect the truth.
            await OtpChallenge.updateOne({ challengeId: verificationId }, { status: 'FAILED' });
            
            // Extract Firebase's specific error message to handle brute-force / attempt limits
            const errorMsg = err.response && err.response.data && err.response.data.error 
                ? err.response.data.error.message 
                : err.message;
            
            if (errorMsg.includes('TOO_MANY_ATTEMPTS')) {
                throw new Error('OTP_RATE_LIMITED');
            } else if (errorMsg.includes('EXPIRED')) {
                throw new Error('OTP_EXPIRED');
            } else {
                throw new Error('OTP_VERIFICATION_FAILED');
            }
        }
    }
}

module.exports = OtpService;

