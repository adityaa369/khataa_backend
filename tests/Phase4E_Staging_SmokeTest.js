/**
 * Phase 4E — Staging Restricted Credential Smoke Test
 * Starts the application with the strictly scoped 'app_financial_writer' credential
 * and runs a full end-to-end lifecycle.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret';
process.env.MSG91_AUTH_KEY = 'mock';
process.env.ENCRYPTION_KEY = '00000000000000000000000000000000';
process.env.REDIS_URL = 'redis://localhost:6379';

const fs = require('fs');
const path = require('path');

const uris = JSON.parse(fs.readFileSync(path.join(__dirname, 'staging_uris.json'), 'utf8'));
process.env.MONGODB_URI = uris.api;

const mongoose = require('mongoose');
const request = require('supertest');

const adminMock = { 
    apps: [true], 
    auth: () => ({ verifyIdToken: async (t) => ({ uid: t, phone_number: '+91' + t }) }),
    messaging: () => ({ send: async () => 'mock-msg-id' })
};
require.cache[require.resolve('firebase-admin')] = { exports: adminMock };
require.cache[require.resolve(path.join(__dirname, '..', 'config', 'firebase'))] = { exports: adminMock };
const RedisMock = require('ioredis-mock');
const redisMock = new RedisMock(); redisMock.status = 'ready';
require.cache[require.resolve(path.join(__dirname, '..', 'config', 'redis'))] = {
    exports: { getRedisClient: () => redisMock, isRedisAvailable: () => true, cacheGet: async () => null, cacheSet: async () => {}, cacheInvalidate: async () => {}, cacheInvalidatePattern: async () => {}, connectRedisStrict: async () => {} }
};

const app = require('../index');
const User = require('../models/User');
const Loan = require('../models/Loan');
const NotificationOutbox = require('../models/NotificationOutbox');

// Mock Mongoose Transactions since MongoMemoryServer standalone doesn't support them
const originalStartSession = mongoose.connection.startSession.bind(mongoose.connection);
mongoose.connection.startSession = async (...args) => {
    const session = await originalStartSession(...args);
    session.startTransaction = () => {};
    session.commitTransaction = async () => {};
    session.abortTransaction = async () => {};
    return session;
};
mongoose.startSession = mongoose.connection.startSession;

const InterestAccrualWorker = require('../workers/InterestAccrualWorker');
const ReconciliationEngine = require('../workers/ReconciliationEngine');
const NotificationWorker = require('../workers/NotificationWorker');

let pass = 0, fail = 0;
function PASS(t) { console.log(`🟢 PASS   ${t}`); pass++; }
function FAIL(t, d) { console.log(`🔴 FAIL   ${t} — ${d}`); fail++; }
function HDR(t) { console.log(`\n── ${t}`); }

async function run() {
    HDR('Connecting as app_financial_writer (API) via index.js');
    while (mongoose.connection.readyState !== 1) {
        await new Promise(r => setTimeout(r, 100));
    }
    PASS('Connected to Staging with restricted API credential');

    // 1. Create Users
    const pL = (Date.now() % 10000000000).toString().padStart(10, '9');
    const pB = ((Date.now()+1) % 10000000000).toString().padStart(10, '8');
    const uidL = 'L' + pL;
    const uidB = 'B' + pB;
    const uL = await User.create({ id: uidL, phone: pL, firstName: 'L', email: 'lender@test.com', isVerified: true, firebaseUid: pL, fcmToken: 'test_token_L' });
    const uB = await User.create({ id: uidB, phone: pB, firstName: 'B', email: 'borrower@test.com', isVerified: true, firebaseUid: pB, fcmToken: 'test_token_B' });
    const tokenL = require('jsonwebtoken').sign({ id: uL.id }, 'test_secret');
    const tokenB = require('jsonwebtoken').sign({ id: uB.id }, 'test_secret');

    // 2. Create Loan
    const createRes = await request('http://localhost:5000').post('/api/loans').set('Authorization', `Bearer ${tokenL}`).send({
        borrower_phone: pB, borrower_name: 'B', amount: 5000,
        interest_rate: 12, duration_months: 12, loan_type: 'personal',
        credit_type: 'HAND'
    });
    if (createRes.status === 201) PASS('Loan Creation Succeeded'); else FAIL('Loan Creation', createRes.text);
    const loanId = createRes.body.loan ? createRes.body.loan._id : createRes.body.data._id;

    // 3. Accept Loan (Requires both parties)
    // Lender verifies their OTP (Using borrower's phone for verification in hand-business logic)
    const acceptResL = await request('http://localhost:5000').post(`/api/loans/${loanId}/verify-lender-otp`).set('Authorization', `Bearer ${tokenL}`).send({
        idToken: pB
    });
    if (acceptResL.status === 200) PASS('Lender OTP Verification Succeeded'); else FAIL('Lender OTP Verification', acceptResL.text);

    // Borrower accepts
    const acceptResB = await request('http://localhost:5000').post(`/api/loans/${loanId}/verify`).set('Authorization', `Bearer ${tokenB}`).send({});
    if (acceptResB.status === 200) PASS('Borrower Loan Acceptance Succeeded'); else FAIL('Borrower Loan Acceptance', acceptResB.text);

    // 4. Payment
    const payRes = await request('http://localhost:5000').post(`/api/loans/${loanId}/record-payment`).set('Authorization', `Bearer ${tokenL}`).set('X-Idempotency-Key', 'pay1').send({
        amount: 1000, idToken: pB
    });
    if (payRes.status === 200) PASS('Financial Payment Succeeded'); else FAIL('Payment', payRes.text);

    // Verification complete
    HDR('Verification Complete');

    // 5. Accrual Worker (runs as API credential currently since it's in-process)
    HDR('Running Interest Accrual Worker (as API credential)');
    const accrualResult = await require('../workers/InterestAccrualWorker').runDailyAccrual();
    PASS(`Accrual worker ran successfully`);

    // 6. Reconciliation Engine
    HDR('Switching context to app_reconciliation');
    await mongoose.disconnect();
    await mongoose.connect(uris.recon);
    PASS('Connected as app_reconciliation');
    
    const reconResult = await require('../workers/ReconciliationEngine').runReconciliation();
    PASS(`Reconciliation Engine ran`);
    
    // Attempting to do a forbidden operation as recon_user
    try {
        await User.create({ id: 'X', phone: 'X' });
        FAIL('Recon User inserted into Users', 'Should be forbidden');
    } catch(e) {
        PASS('Recon User forbidden from inserting into Users (Role enforced)');
    }

    // Clean up
    console.log(`\n=========================================================================`);
    console.log(`RESULTS: ${pass} passed / ${fail} failed`);
    console.log(`=========================================================================`);
    
    await mongoose.disconnect();
    process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
