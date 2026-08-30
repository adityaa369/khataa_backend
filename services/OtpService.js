const OtpChallenge = require('../models/OtpChallenge');
const { triggerAlert } = require('../utils/telemetry');

/**
 * OtpService — Firebase ID Token verification with replay protection.
 *
 * This service uses the Firebase Admin SDK (verifyIdToken) as the SOLE
 * verification mechanism. The old REST Identity Toolkit path
 * (signInWithPhoneNumber + FIREBASE_API_KEY) has been eliminated.
 *
 * Flutter client flow:
 *   1. User completes phone OTP on device → Firebase SDK returns an ID token
 *   2. Client sends { idToken } to backend
 *   3. Backend calls OtpService.verifyAndConsume({ idToken, userId, purpose, ... })
 *   4. Admin SDK verifies the token → extracts uid + phone_number
 *   5. Backend cross-checks phone_number against resource (e.g. loan.borrowerPhone)
 */
class OtpService {
    /**
     * Verifies a Firebase ID Token using the Admin SDK.
     * Enforces strict atomic challenge consumption, replay protection, and purpose binding.
     *
     * @param {Object} options
     * @param {string} options.idToken         - Firebase ID token from the Flutter client
     * @param {string} options.userId          - Authenticated Mongo user ID (req.user.id)
     * @param {string} options.purpose         - 'VERIFY_LENDER_OTP' | 'CLOSE_LOAN' | 'RECORD_PAYMENT'
     * @param {string|null} options.resourceId - Loan ID (for audit + replay binding)
     * @param {number|null} options.expectedAmountPaise - For RECORD_PAYMENT replay binding
     * @returns {{ success: boolean, uid: string, phone: string }}
     */
    static async verifyAndConsume({ idToken, userId, purpose, resourceId = null, expectedAmountPaise = null }) {
        if (!idToken) {
            throw new Error('VALIDATION_ERROR: Missing Firebase ID token');
        }

        // 1. Firebase Authority Verification — Admin SDK only
        let decoded;
        try {
            const admin = require('../config/firebase');
            if (!admin.apps || !admin.apps.length) {
                throw new Error('Firebase Admin SDK not initialized');
            }
            decoded = await admin.auth().verifyIdToken(idToken);
        } catch (err) {
            const msg = err.message || '';
            if (msg.includes('expired'))     throw new Error('OTP_EXPIRED');
            if (msg.includes('audience'))    throw new Error('OTP_WRONG_PROJECT');
            if (msg.includes('signature'))   throw new Error('OTP_INVALID_SIGNATURE');
            throw new Error('OTP_VERIFICATION_FAILED');
        }

        const verifiedUid = decoded.uid;
        const verifiedPhone = decoded.phone_number;

        if (!verifiedUid || !verifiedPhone) {
            throw new Error('OTP_MISSING_CLAIMS');
        }

        // Normalize phone to 10 digits (Indian)
        let phone = verifiedPhone.replace(/\D/g, '');
        if (phone.startsWith('91') && phone.length > 10) phone = phone.substring(2);

        // 2. Atomic Replay & Concurrency Protection
        // Bind replay key to: uid + purpose + resourceId + amount
        // This prevents the same Firebase token from being used twice for
        // the same financial operation on the same resource.
        const replayKey = `${verifiedUid}:${purpose}:${resourceId || 'none'}:${expectedAmountPaise || '0'}`;
        try {
            await OtpChallenge.create({
                challengeId: replayKey,
                userId,
                purpose,
                resourceId,
                expectedAmountPaise,
                status: 'CONSUMED'
            });
        } catch (err) {
            if (err.code === 11000) {
                // Duplicate key → same operation replayed
                const existing = await OtpChallenge.findOne({ challengeId: replayKey });
                if (existing && existing.purpose !== purpose) {
                    triggerAlert('OTP_PURPOSE_MISMATCH', 'HIGH', { userId, purpose, resourceId });
                    throw new Error('OTP_PURPOSE_MISMATCH');
                }
                triggerAlert('OTP_REPLAY', 'HIGH', { userId, purpose, resourceId });
                throw new Error('OTP_REPLAY_REJECTED');
            }
            throw err;
        }

        return { success: true, uid: verifiedUid, phone };
    }
}

module.exports = OtpService;
