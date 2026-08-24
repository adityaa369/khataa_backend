const axios = require('axios');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';

async function test() {
    await mongoose.connect(MONGODB_URI);
    const Admin = mongoose.model('Admin', new mongoose.Schema({ email: String, role: String, mfaSecret: String }));
    const FinancialKillSwitch = mongoose.model('FinancialKillSwitch', new mongoose.Schema({ key: String, enabled: Boolean }, { timestamps: true }));
    
    // Cleanup state
    await FinancialKillSwitch.deleteMany({ key: 'FINANCIAL' });

    let admin = await Admin.findOne({ email: 'operator@khatha.app' });
    if (!admin.mfaSecret) {
        const secret = speakeasy.generateSecret({ length: 20 });
        admin.mfaSecret = secret.base32;
        await Admin.updateOne({ email: 'operator@khatha.app' }, { mfaSecret: secret.base32 });
        admin = await Admin.findOne({ email: 'operator@khatha.app' });
        console.log("Generated MFA Secret:", admin.mfaSecret);
    }
    
    const token = jwt.sign({ adminId: admin._id, role: admin.role, mfaVerified: true }, '1be3118c693f296ea3f5f1d57b878a88bd81b53f3a086f1e33823a96b4dc4424', { expiresIn: '1h' });
    const headers = { Authorization: `Bearer ${token}` };

    // Get current OTP
    const mfaToken = speakeasy.totp({ secret: admin.mfaSecret, encoding: 'base32' });

    try {
        console.log("1. Activate...");
        let res = await axios.post('http://localhost:5000/api/admin/kill-switch/activate', { reason: 'Test E.6', mfaToken }, { headers });
        console.log("Activation:", res.data.killSwitch.enabled);

        console.log("2. Duplicate Activate...");
        try {
            await axios.post('http://localhost:5000/api/admin/kill-switch/activate', { reason: 'Test E.6', mfaToken }, { headers });
        } catch (e) {
            console.log("Duplicate prevented:", e.response.status, e.response.data.message);
        }

        console.log("3. Financial Enforcement...");
        try {
            // Pick a financial route, e.g. POST /api/loans/disburse
            await axios.post('http://localhost:5000/api/loans/apply', {}, { headers });
        } catch (e) {
            console.log("Financial blocked:", e.response.status, e.response.data.message);
        }

        console.log("4. Deactivate...");
        res = await axios.post('http://localhost:5000/api/admin/kill-switch/deactivate', { reason: 'Test ended', mfaToken }, { headers });
        console.log("Deactivation:", res.data.killSwitch.enabled);

    } catch (e) {
        console.error("Error:", e.response ? e.response.data : e.message);
    }
    
    process.exit(0);
}
test();
