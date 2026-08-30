const fs = require('fs');
let c = fs.readFileSync('controllers/loans.js', 'utf8');

c = c.replace(/const { amount, verificationId, otp, intentId } = req\.body;/g, 'const { amount, idToken, intentId } = req.body;');
c = c.replace(/const { otp, verificationId } = req\.body;/g, 'const { idToken } = req.body;');
c = c.replace(/const verificationResult = await verifyFirebaseOtp\(verificationId, otp\);/g, 'const verificationResult = await verifyFirebaseIdToken(idToken);');

const idTokenFn = `async function verifyFirebaseIdToken(idToken) {
    if (!idToken) return { success: false, message: 'Missing idToken' };
    try {
        const admin = require('firebase-admin');
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        if (!decodedToken.phone_number) return { success: false, message: 'No phone number in token' };
        return { success: true, phone: decodedToken.phone_number };
    } catch (err) {
        console.error('[Firebase] Verify Token Error:', err.message);
        return { success: false, message: 'Invalid idToken' };
    }
}`;
c = c.replace(/async function verifyFirebaseOtp\([\s\S]*?^}/m, idTokenFn);

fs.writeFileSync('controllers/loans.js', c);
console.log('Fixed controllers/loans.js');
