import os

with open('controllers/loans.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Replace verifyFirebaseOtp with verifyFirebaseIdToken
new_id_token_fn = """async function verifyFirebaseIdToken(idToken) {
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
}"""
content = content.replace("async function verifyFirebaseOtp(verificationId, otp) {", new_id_token_fn + "\n/*")
content = content.replace("return { success: false, message: err.response?.data?.error?.message || 'Verification failed' };\n    }\n}", "*/")

# 2. Update verifyLenderOtp
content = content.replace("const { otp, verificationId } = req.body;", "const { idToken } = req.body;")
content = content.replace("if (!verificationId) {\n            return res.status(400).json({ success: false, message: 'verificationId is required' });\n        }\n\n        const verificationResult = await verifyFirebaseOtp(verificationId, otp);", "const verificationResult = await verifyFirebaseIdToken(idToken);")
content = content.replace("if (!verificationId) {\r\n            return res.status(400).json({ success: false, message: 'verificationId is required' });\r\n        }\r\n\r\n        const verificationResult = await verifyFirebaseOtp(verificationId, otp);", "const verificationResult = await verifyFirebaseIdToken(idToken);")

# 3. Update closeLoan (same replacements usually apply, but let's be safe)
content = content.replace("const verificationResult = await verifyFirebaseOtp(verificationId, otp);", "const verificationResult = await verifyFirebaseIdToken(idToken);")
content = content.replace("if (!verificationId) {\n            return res.status(400).json({ success: false, message: 'verificationId is required' });\n        }\n\n        const verificationResult = await verifyFirebaseIdToken(idToken);", "const verificationResult = await verifyFirebaseIdToken(idToken);")
content = content.replace("if (!verificationId) {\r\n            return res.status(400).json({ success: false, message: 'verificationId is required' });\r\n        }\r\n\r\n        const verificationResult = await verifyFirebaseIdToken(idToken);", "const verificationResult = await verifyFirebaseIdToken(idToken);")


# 4. Update _handleCustomTransaction
content = content.replace("const { amount, otp, verificationId } = req.body;", "const { amount, idToken } = req.body;")
content = content.replace("if (!otp || !verificationId) {\n                return res.status(400).json({ success: false, message: 'OTP and verificationId are required' });\n            }", "if (!idToken) {\n                return res.status(400).json({ success: false, message: 'idToken is required' });\n            }")
content = content.replace("if (!otp || !verificationId) {\r\n                return res.status(400).json({ success: false, message: 'OTP and verificationId are required' });\r\n            }", "if (!idToken) {\n                return res.status(400).json({ success: false, message: 'idToken is required' });\n            }")


with open('controllers/loans.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Safe string replace completed.")
