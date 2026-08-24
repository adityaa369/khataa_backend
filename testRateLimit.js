const axios = require('axios');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const API_URL = 'https://khataa-backend.onrender.com';

async function verifyDeployment() {
    try {
        console.log("Starting controlled generation...");

        // Rate Limit (10x bad passwords)
        for(let i=0; i<10; i++) {
             try { await axios.post(`${API_URL}/api/auth/login-password`, { phone: "9999999999", password: "wrong" }); } catch(e) {}
        }
        
        // Wait for persistence
        await new Promise(r => setTimeout(r, 2000));
        
        // Connect to DB directly to fetch admin token and check events manually
        await mongoose.connect('mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0');
        const SecurityEvent = mongoose.model('SecurityEvent', new mongoose.Schema({ eventId: String, eventType: String, metadata: Object }, {strict: false}));
        
        const rateLimits = await SecurityEvent.find({ eventType: 'RATE_LIMIT_EXCEEDED' }).lean();
        console.log(`Found RATE_LIMIT_EXCEEDED events: ${rateLimits.length}`);
        if(rateLimits.length > 0) {
            console.log("Latest RL Event:", JSON.stringify(rateLimits[rateLimits.length-1], null, 2));
        }

        process.exit(0);
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
}
verifyDeployment();
