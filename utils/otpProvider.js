const admin = require('../config/firebase');
const axios = require('axios');

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

/**
 * Send custom OTP (Loan Consent) via MSG91
 * Firebase cannot send arbitrary SMS to other phones from the backend.
 * This function uses MSG91 specifically for borrower consent verification.
 */
const sendOtp = async (phone, otp) => {
    try {
        const authKey = process.env.MSG91_AUTH_KEY;
        const templateId = process.env.MSG91_TEMPLATE_ID;

        if (!authKey || !templateId) {
             console.error('[MSG91] Missing credentials in environment variables.');
             return { success: false, message: 'Server missing SMS configuration' };
        }

        let mobile = phone.toString();
        // Ensure format is 91xxxxxxxxxx for MSG91
        if (mobile.startsWith('+')) {
            mobile = mobile.substring(1);
        } else if (!mobile.startsWith('91') && mobile.length === 10) {
            mobile = `91${mobile}`;
        }

        const url = `https://control.msg91.com/api/v5/otp?template_id=${templateId}&mobile=${mobile}&authkey=${authKey}`;
        
        console.log(`[MSG91] Requesting SMS to ${mobile} via MSG91...`);
        const response = await axios.post(url, { otp: otp }, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.type === 'success') {
             return { success: true, message: 'OTP sent successfully' };
        } else {
             console.error('[MSG91] API Response Error:', response.data);
             return { success: false, message: response.data.message || 'Failed to send SMS' };
        }
    } catch (error) {
        console.error('[MSG91] Network Error:', error.message);
        return { success: false, message: error.message };
    }
};

module.exports = { verifyFirebaseToken, sendOtp };
