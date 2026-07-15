const admin = require('firebase-admin');

/**
 * Send an FCM Push Notification
 * @param {string} token - The user's device fcmToken
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional data payload
 */
exports.sendPushNotification = async (token, title, body, data = {}) => {
    if (!token) return { success: false, message: 'No FCM token provided' };

    try {
        const message = {
            notification: {
                title,
                body
            },
            data,
            token
        };

        const response = await admin.messaging().send(message);
        console.log(`[FCM] Successfully sent message:`, response);
        return { success: true, response };
    } catch (error) {
        console.error(`[FCM] Error sending message to ${token}:`, error.message);
        return { success: false, error: error.message };
    }
};
