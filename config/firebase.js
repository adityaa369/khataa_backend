const admin = require('firebase-admin');

// Ensure to pass the path to the downloaded service account JSON key via ENVs or place the file directly for testing.
// In Render, it's best to base64 encode the JSON and put it in an ENV variable to parse.
// For now, we initialize an empty app structure assuming GOOGLE_APPLICATION_CREDENTIALS or similar setup will be done.
try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
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
