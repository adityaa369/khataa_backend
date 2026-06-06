const admin = require('firebase-admin');

// Ensure to pass the path to the downloaded service account JSON key via ENVs or place the file directly for testing.
// In Render, it's best to base64 encode the JSON and put it in an ENV variable to parse.
// For now, we initialize an empty app structure assuming GOOGLE_APPLICATION_CREDENTIALS or similar setup will be done.
// Helper to safely parse stringified Firebase service account, handling missing outer braces
const parseServiceAccount = (rawEnv) => {
    if (!rawEnv) return null;
    let jsonStr = rawEnv.trim();
    if (!jsonStr.startsWith('{')) {
        jsonStr = '{' + jsonStr;
    }
    if (!jsonStr.endsWith('}')) {
        jsonStr = jsonStr + '}';
    }
    return JSON.parse(jsonStr);
};

try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        } else {
            admin.initializeApp();
        }
    }
} catch (error) {
    console.error('[Firebase] Initialization Error:', error.message);
}

module.exports = admin;
