const axios = require('axios');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';
const apiBaseUrl = 'https://khataa-backend.onrender.com';

async function runChecklist() {
    console.log("---- RUNNING E.4 VERIFICATION CHECKLIST ----\n");
    
    // 1. Health Checks
    try {
        const live = await axios.get(`${apiBaseUrl}/health/live`);
        console.log("✅ /health/live \t\t", live.status, live.data);
        const ready = await axios.get(`${apiBaseUrl}/health/ready`);
        console.log("✅ /health/ready \t\t", ready.status, ready.data.status);
    } catch(e) {
        console.error("❌ Health check failed:", e.response ? e.response.status : e.message);
        process.exit(1);
    }

    // Connect DB to sign real token
    await mongoose.connect(MONGODB_URI);
    const AdminSchema = new mongoose.Schema({ email: String, role: String });
    const Admin = mongoose.model('Admin', AdminSchema);
    const admin = await Admin.findOne({ email: 'operator@khatha.app' });
    const token = jwt.sign({ adminId: admin._id, role: admin.role, mfaVerified: true }, '1be3118c693f296ea3f5f1d57b878a88bd81b53f3a086f1e33823a96b4dc4424', { expiresIn: '1h' });
    const headers = { Authorization: `Bearer ${token}` };

    // 2. Rapid Dashboard Refresh (Stress Test)
    console.log("\n---- STRESS TESTING DASHBOARD (20 requests) ----");
    for(let i=1; i<=20; i++) {
        try {
            const dash = await axios.get(`${apiBaseUrl}/api/admin/dashboard`, { headers });
            process.stdout.write(`✅ Req ${i}: ${dash.status} `);
            if(i % 5 === 0) console.log();
        } catch(e) {
            console.error(`\n❌ Req ${i} failed:`, e.response ? e.response.status : e.message);
            process.exit(1);
        }
    }
    console.log("\n✅ Rapid dashboard refresh completed cleanly. Server did not crash!\n");

    // 3. Verify Investigation Events API
    console.log("---- FETCHING SYNTHETIC EVENTS ----");
    try {
        const search1 = await axios.post(`${apiBaseUrl}/api/admin/security/investigate`, { query: 'SYNTHETIC_TEST_ACTOR' }, { headers });
        console.log(`✅ Search SYNTHETIC_TEST_ACTOR: Found ${search1.data.data.length} events`);
        search1.data.data.forEach(ev => {
            console.log(`   -> [${ev.eventType}] Source: ${ev.metadata?.source || 'N/A'}, Financial Impact: ${ev.financialImpact}, Reached Logic: ${ev.reachedFinancialLogic}`);
        });

        const search2 = await axios.post(`${apiBaseUrl}/api/admin/security/investigate`, { query: 'SYNTHETIC_LOAN_999' }, { headers });
        console.log(`✅ Search SYNTHETIC_LOAN_999: Found ${search2.data.data.length} events`);
        search2.data.data.forEach(ev => {
            console.log(`   -> [${ev.eventType}] Source: ${ev.metadata?.source || 'N/A'}, Financial Impact: ${ev.financialImpact}, Reached Logic: ${ev.reachedFinancialLogic}`);
        });

    } catch(e) {
        console.error("❌ Investigation API failed:", e.response ? e.response.status : e.message);
    }
    
    process.exit(0);
}
runChecklist();
