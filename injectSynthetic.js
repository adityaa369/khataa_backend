const mongoose = require('mongoose');
const { triggerAlert, trackFinancialEvent } = require('./utils/telemetry');
const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';

async function inject() {
    console.log("Connecting to Database...");
    await mongoose.connect(MONGODB_URI);
    
    console.log("Injecting Synthetic OTP_REPLAY...");
    triggerAlert('OTP_REPLAY', 'HIGH', { 
        source: 'APPLICATION_LAYER',
        userId: 'SYNTHETIC_TEST_ACTOR', 
        purpose: 'LOGIN', 
        resourceId: 'SYNTHETIC_VID_123',
        notes: 'This is a synthetic verification event'
    });

    console.log("Injecting Synthetic RATE_LIMIT_EXCEEDED...");
    triggerAlert('RATE_LIMIT_EXCEEDED', 'MEDIUM', { 
        source: 'EXPRESS_RATE_LIMIT',
        key: 'rl:ip:127.0.0.1:login',
        originalUrl: '/api/auth/login-password',
        actorId: 'SYNTHETIC_TEST_ACTOR'
    });

    console.log("Injecting Synthetic OVERPAYMENT_ATTEMPT...");
    triggerAlert('OVERPAYMENT_ATTEMPT', 'CRITICAL', {
        source: 'APPLICATION_LAYER',
        loanId: 'SYNTHETIC_LOAN_999',
        amountPaise: 500000,
        actorId: 'SYNTHETIC_TEST_ACTOR'
    });

    // Wait 2 seconds to allow async persistence
    await new Promise(r => setTimeout(r, 2000));
    console.log("Synthetic evidence injected successfully.");
    process.exit(0);
}
inject();
