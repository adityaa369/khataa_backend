require('../config/firebase'); // Ensure initialization runs
const { getAuth } = require('firebase-admin/auth');
const { getApps } = require('firebase-admin/app');

/**
 * Verify Firebase ID Token
 */
const verifyFirebaseToken = async (idToken) => {
    try {
        if (getApps().length === 0) {
            console.error('[Firebase] Admin SDK is not initialized. Cannot verify token.');
            return { success: false, message: 'Server configuration error' };
        }

        const decodedToken = await getAuth().verifyIdToken(idToken);

        const phone = decodedToken.phone_number;

        if (!phone) {
            return { success: false, message: 'No phone number linked to this Firebase credential' };
        }

        return {
            success: true,
            mobile: phone,
            uid: decodedToken.uid
        };
    } catch (error) {
        console.error('[Firebase] Verify Token Error:', error.message);
        return { success: false, message: error.message || 'Invalid Firebase Token' };
    }
};

const sendOtp = async (phone, otp) => {
    if (process.env.NODE_ENV !== 'production') {
        console.log(`\n=========================================`);
        console.log(`[MOCK SMS] Firebase cannot send custom backend OTPs.`);
        console.log(`[MOCK SMS] Please read the real OTP below to test the UI:`);
        console.log(`[MOCK SMS] OTP for ${phone} is: ${otp}`);
        console.log(`=========================================\n`);
    }
    return { success: true };
};

module.exports = { verifyFirebaseToken, sendOtp };
