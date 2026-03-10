const admin = require('../config/firebase');

/**
 * Verify Firebase ID Token
 * When the Flutter app successfully completes Phone Auth, it receives an ID Token.
 * It sends that token to our backend, and we verify it here using the Admin SDK.
 */
const verifyFirebaseToken = async (idToken) => {
    try {
        if (!admin.apps.length) {
            console.error('[Firebase] Admin SDK is not initialized. Cannot verify token.');
            return { success: false, message: 'Server configuration error' };
        }

        const decodedToken = await admin.auth().verifyIdToken(idToken);

        // decodedToken contains the user's phone_number if they signed in via Phone Auth
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

module.exports = { verifyFirebaseToken };
