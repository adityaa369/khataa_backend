const axios = require('axios');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';
const API_URL = 'https://khataa-backend.onrender.com';
const JWT_SECRET = '1be3118c693f296ea3f5f1d57b878a88bd81b53f3a086f1e33823a96b4dc4424';

async function verifyDeployment() {
    try {
        console.log("Connecting to MongoDB to read actual state...");
        await mongoose.connect(MONGODB_URI);
        const AdminSchema = new mongoose.Schema({ email: String, role: String });
        const Admin = mongoose.model('Admin', AdminSchema);
        
        const admin = await Admin.findOne({ email: 'operator@khatha.app' });
        const token = jwt.sign(
            { adminId: admin._id, role: admin.role, mfaVerified: true }, 
            JWT_SECRET, 
            { expiresIn: '1h' }
        );
        console.log("Generated Admin Token.");

        const headers = { Authorization: `Bearer ${token}` };
        
        console.log("\n--- Triggering Controlled Events ---");
        const dummyVerificationId = "vid_" + Date.now();
        
        // 1. Send first OTP verification (will fail Firebase auth, but reserve the challengeId)
        try {
            await axios.post(`${API_URL}/api/auth/verify-otp`, { 
                verificationId: dummyVerificationId, 
                otp: '123456', 
                userId: 'test_usr_123', 
                purpose: 'LOGIN' 
            });
        } catch(e) { }

        // 2. Send SECOND OTP verification with SAME id -> triggers OTP_REPLAY
        console.log("Triggering OTP_REPLAY...");
        try {
            await axios.post(`${API_URL}/api/auth/verify-otp`, { 
                verificationId: dummyVerificationId, 
                otp: '123456', 
                userId: 'test_usr_123', 
                purpose: 'LOGIN' 
            });
        } catch(e) { }

        // 3. Trigger RATE_LIMIT_EXCEEDED (requires 4 total requests to verify-otp)
        console.log("Triggering RATE_LIMIT_EXCEEDED...");
        for (let i = 0; i < 3; i++) {
            try {
                await axios.post(`${API_URL}/api/auth/verify-otp`, { 
                    verificationId: "vid_" + Date.now() + i, 
                    otp: '123456', 
                    userId: 'test_usr_123', 
                    purpose: 'LOGIN' 
                });
            } catch(e) { }
        }

        // Wait a second for async telemetry persistence
        await new Promise(r => setTimeout(r, 2000));

        // 4. Verify E.4 /security/events API
        console.log("\n--- E.4 Security Events API ---");
        const secEventsRes = await axios.get(`${API_URL}/api/admin/security/events`, { headers });
        console.log(`Security Events count: ${secEventsRes.data.data.length}`);
        
        const replays = secEventsRes.data.data.filter(e => e.eventType === 'OTP_REPLAY');
        console.log(`Found OTP_REPLAY events: ${replays.length}`);
        if (replays.length > 0) {
            console.log("OTP_REPLAY Event:");
            console.log(`  Result: ${replays[0].result}`);
            console.log(`  Financial Impact: ${replays[0].financialImpact}`);
            console.log(`  Metadata: ${JSON.stringify(replays[0].metadata)}`);
        }

        const rateLimits = secEventsRes.data.data.filter(e => e.eventType === 'RATE_LIMIT_EXCEEDED');
        console.log(`Found RATE_LIMIT_EXCEEDED events: ${rateLimits.length}`);
        if (rateLimits.length > 0) {
            console.log("RATE_LIMIT Event:");
            console.log(`  Result: ${rateLimits[0].result}`);
            console.log(`  Metadata: ${JSON.stringify(rateLimits[0].metadata)}`);
        }

        // 5. Verify E.5 Investigation API
        console.log("\n--- E.5 Investigation API (Search by userId) ---");
        const invRes = await axios.get(`${API_URL}/api/admin/security/investigate?query=test_usr_123`, { headers });
        console.log(`Results for 'test_usr_123' search: ${invRes.data.data.length}`);
        
        console.log("\n--- E.5 Investigation API (Search by rate limit key) ---");
        if (rateLimits.length > 0 && rateLimits[0].metadata && rateLimits[0].metadata.key) {
             const keyRes = await axios.get(`${API_URL}/api/admin/security/investigate?query=${encodeURIComponent(rateLimits[0].metadata.key)}`, { headers });
             console.log(`Results for rate limit key search: ${keyRes.data.data.length}`);
        }

        process.exit(0);
    } catch (e) {
        console.error("Error during verification:", e.response ? e.response.data : e.message);
        process.exit(1);
    }
}
verifyDeployment();
