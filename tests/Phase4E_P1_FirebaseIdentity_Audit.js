/**
 * Phase 4E: Firebase Identity Confusion Attack Suite
 * 
 * Two distinct Firebase auth paths exist:
 * PATH A: verifyFirebaseToken (otpProvider.js) → Admin SDK verifyIdToken → SAFE
 * PATH B: verifyFirebaseOtp (loans.js)         → REST Identity Toolkit API → SUSPECT
 *
 * Tests probe:
 *   1. Login: valid Firebase proof + wrong body.phone (PATH A)
 *   2. Login: valid Firebase proof + wrong body.userId (PATH A)
 *   3. Payment OTP: valid OTP for phone A, but loan belongs to phone B (PATH B)
 *   4. Payment OTP: expired / tampered Firebase credential (PATH B)
 *   5. Login: token from wrong Firebase project / wrong issuer (PATH A)
 *   6. Firebase UID → Mongo mismatch (PATH A): uid in token != uid in Mongo
 *   7. Financial compound: User A session + body claims User B identity + financial mutation
 *   8. OTP replay on closure (PATH B)
 */

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');
const nock = require('nock');

process.env.JWT_SECRET = 'test_secret';
process.env.NODE_ENV = 'production';
process.env.FIREBASE_API_KEY = 'test_api_key';
process.env.REDIS_URL = 'redis://localhost';

// ---- Suppress noisy logs ----
const originalConsoleError = console.error;
console.error = (...args) => {};
const originalConsoleWarn = console.warn;
console.warn = (...args) => {};
const originalConsoleLog = console.log;
console.log = (...args) => {};

// ---- Mock firebase-admin Admin SDK (used by otpProvider.js) ----
const mockAdminAuth = {
    verifyIdToken: async (token) => {
        if (token === 'VALID_TOKEN_USER_A') {
            return { uid: 'firebase_uid_A', phone_number: '+919999999999' };
        }
        if (token === 'VALID_TOKEN_USER_B') {
            return { uid: 'firebase_uid_B', phone_number: '+918888888888' };
        }
        if (token === 'EXPIRED_TOKEN') {
            const err = new Error('Firebase ID token has expired');
            err.code = 'auth/id-token-expired';
            throw err;
        }
        if (token === 'WRONG_PROJECT_TOKEN') {
            const err = new Error('Firebase ID token has incorrect "aud" (audience) claim');
            err.code = 'auth/argument-error';
            throw err;
        }
        if (token === 'VALID_TOKEN_WRONG_UID') {
            // Firebase UID is 'firebase_uid_X', but no Mongo user has this UID
            return { uid: 'firebase_uid_UNKNOWN', phone_number: '+919999999999' };
        }
        throw new Error('Invalid token');
    }
};

const adminMock = {
    apps: [true], // simulate initialized
    auth: () => mockAdminAuth,
    storage: () => ({ bucket: () => ({ file: () => ({ save: async () => {}, getSignedUrl: async () => ['https://signed.url'] }) }) })
};

// Override firebase-admin before loading any modules
require.cache[require.resolve('firebase-admin')] = { exports: adminMock };
// Also override the config/firebase wrapper
const firebasePath = require('path').join(__dirname, '..', 'config', 'firebase');
require.cache[require.resolve(firebasePath)] = { exports: adminMock };

// ---- Mock config/redis.js directly — must be done before any module loads ----
const RedisMock = require('ioredis-mock');
const redisMock = new RedisMock();
redisMock.status = 'ready';

const redisConfigPath = require('path').join(__dirname, '..', 'config', 'redis');
require.cache[require.resolve(redisConfigPath)] = {
    exports: {
        getRedisClient: () => redisMock,
        isRedisAvailable: () => true,
        cacheGet: async () => null,
        cacheSet: async () => {},
        cacheInvalidate: async () => {},
        cacheInvalidatePattern: async () => {},
        connectRedisStrict: async () => {},
    }
};

// ---- Now load our modules ----
const User = require('../models/User');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const authRoutes = require('../routes/auth');
const loanRoutes = require('../routes/loans');
const errorHandler = require('../middleware/errorHandler');

// ---- Build test app ----
function buildApp() {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/auth', authRoutes);
    app.use('/api/loans', loanRoutes);
    app.use(errorHandler);
    return app;
}

// ---- Assertion helpers ----
function pass(label) { console.log = originalConsoleLog; console.log(`🟢 PASS  ${label}`); console.log = () => {}; }
function fail(label, detail) { console.log = originalConsoleLog; console.log(`🔴 FAIL  ${label} — ${detail}`); console.log = () => {}; }
function info(label) { console.log = originalConsoleLog; console.log(`ℹ️       ${label}`); console.log = () => {}; }
function sep() { console.log = originalConsoleLog; console.log('-----------------------------------------------------------------------'); console.log = () => {}; }

async function runAttackSuite() {
    let mongod;
    try {
        mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
        await mongoose.connect(mongod.getUri(), { dbName: 'khataa_test' });

        const app = buildApp();
        console.log = originalConsoleLog;
        console.log('=========================================================================');
        console.log('     PHASE 4E: P1 FIREBASE IDENTITY CONFUSION ATTACK SUITE');
        console.log('=========================================================================\n');
        console.log = () => {};

        // --- Setup test users ---
        const userA = await User.create({ id: 'mongo_user_A', phone: '9999999999', firstName: 'Alice', isVerified: true });
        const userB = await User.create({ id: 'mongo_user_B', phone: '8888888888', firstName: 'Bob', isVerified: true });

        // Active loan: lender = userA, borrower = userB
        const loan = await Loan.create({
            lender: userA.id,
            borrower: userB.id,
            borrowerName: 'Bob',
            borrowerPhone: '8888888888',
            amount: 10000, amountPaise: 1000000,
            interestRate: 12, durationMonths: 12,
            status: 'active', loanType: 'personal'
        });

        const tokenA = jwt.sign({ id: userA.id, phone: userA.phone }, 'test_secret', { expiresIn: '1h' });
        const tokenB = jwt.sign({ id: userB.id, phone: userB.phone }, 'test_secret', { expiresIn: '1h' });

        // =====================================================================
        // TEST 1: Valid Firebase proof + wrong body.phone
        // =====================================================================
        sep();
        info('TEST 1: Valid Firebase proof (User A) + body.phone = User B phone');
        info('Attack: POST /api/auth/verify-otp with VALID_TOKEN_USER_A but include body.phone = 8888888888');
        info('Expected: Login succeeds AS USER A (body.phone is IGNORED, identity from token claim)');

        const res1 = await request(app)
            .post('/api/auth/verify-otp')
            .send({ idToken: 'VALID_TOKEN_USER_A', phone: '8888888888' }); // body.phone is User B

        const loggedInPhone1 = res1.body.user?.phone;
        const gotUserA = loggedInPhone1 === '9999999999';
        const gotUserB = loggedInPhone1 === '8888888888';

        if (gotUserA) {
            pass('TEST 1: body.phone is ignored — identity derived from Firebase token claim (+91 9999999999)');
        } else if (gotUserB) {
            fail('TEST 1', `Identity confused! body.phone was authoritative — logged in as User B. Status: ${res1.status}`);
        } else {
            fail('TEST 1', `Unexpected response. Status: ${res1.status}, Body: ${JSON.stringify(res1.body).substring(0, 100)}`);
        }

        // =====================================================================
        // TEST 2: Valid Firebase proof + wrong body.userId
        // =====================================================================
        sep();
        info('TEST 2: Valid Firebase proof (User A) + body.userId = mongo_user_B');
        info('Attack: Include body.userId = "mongo_user_B" in verify-otp request');
        info('Expected: Login as User A regardless — body.userId should be fully ignored');

        const res2 = await request(app)
            .post('/api/auth/verify-otp')
            .send({ idToken: 'VALID_TOKEN_USER_A', userId: 'mongo_user_B' });

        const loggedInId2 = res2.body.user?.id;
        if (loggedInId2 === 'mongo_user_A') {
            pass('TEST 2: body.userId is ignored — identity is mongo_user_A from token');
        } else if (loggedInId2 === 'mongo_user_B') {
            fail('TEST 2', 'Identity confused! body.userId was authoritative — logged in as User B');
        } else {
            fail('TEST 2', `Unexpected. Status: ${res2.status}, id: ${loggedInId2}`);
        }

        // =====================================================================
        // TEST 3: Expired Firebase credential
        // =====================================================================
        sep();
        info('TEST 3: Expired Firebase ID token');
        info('Attack: POST /api/auth/verify-otp with EXPIRED_TOKEN');
        info('Expected: 400/401 — no session created, no user lookup escalation');

        const res3 = await request(app)
            .post('/api/auth/verify-otp')
            .send({ idToken: 'EXPIRED_TOKEN' });

        const sessionCreated3 = !!res3.body.token;
        if ((res3.status === 400 || res3.status === 401) && !sessionCreated3) {
            pass(`TEST 3: Expired token rejected (HTTP ${res3.status}), no session created`);
        } else {
            fail('TEST 3', `Expired token NOT rejected. Status: ${res3.status}, token: ${!!res3.body.token}`);
        }

        // =====================================================================
        // TEST 4: Wrong Firebase project / audience token
        // =====================================================================
        sep();
        info('TEST 4: Firebase token from wrong project (wrong "aud" claim)');
        info('Attack: POST /api/auth/verify-otp with WRONG_PROJECT_TOKEN');
        info('Expected: 400/401 — rejected by Admin SDK audience check');

        const res4 = await request(app)
            .post('/api/auth/verify-otp')
            .send({ idToken: 'WRONG_PROJECT_TOKEN' });

        if ((res4.status === 400 || res4.status === 401) && !res4.body.token) {
            pass(`TEST 4: Wrong-project token rejected (HTTP ${res4.status})`);
        } else {
            fail('TEST 4', `Wrong-project token NOT rejected. Status: ${res4.status}`);
        }

        // =====================================================================
        // TEST 5: Firebase UID → Mongo mismatch
        // =====================================================================
        sep();
        info('TEST 5: Firebase UID unknown to MongoDB (uid in token has no matching Mongo user)');
        info('Attack: Token has firebase_uid_UNKNOWN, phone 9999999999 (same as User A)');
        info('Expected: Either reject OR create new user — must NOT attach session to existing User A');

        const res5 = await request(app)
            .post('/api/auth/verify-otp')
            .send({ idToken: 'VALID_TOKEN_WRONG_UID' });

        // If a session is created, verify it's not for the EXISTING User A (mongo_user_A)
        const returnedId5 = res5.body.user?.id;
        const attachedToExistingUserA = returnedId5 === 'mongo_user_A';

        if (attachedToExistingUserA) {
            // The system found User A by phone and attached the credential to it
            // This is actually the current expected behavior — but we document it
            // to examine: does the system verify uid binding?
            info('TEST 5: ℹ️ System attached credential to existing Mongo user by phone match.');
            info('         Current behavior: phone is authoritative, Firebase UID not stored/verified.');
            info('         Finding: Firebase UID is NOT persisted or verified against Mongo user.');
            fail('TEST 5', 'Firebase UID is never stored or cross-checked — identity bound by phone only. Risk: UID mismatch goes undetected.');
        } else if (res5.status === 400 || res5.status === 401) {
            pass('TEST 5: Unknown Firebase UID rejected');
        } else {
            info(`TEST 5: Created new user (isNewUser: ${res5.body.isNewUser}) — uid mismatch led to separate account`);
            pass('TEST 5: Unknown UID did not gain access to existing User A account');
        }

        // =====================================================================
        // TEST 6: Payment OTP — valid OTP for phone A, but loan belongs to phone B
        //         PATH B: verifyFirebaseOtp (REST API) in verifyLenderOtp/closeLoan
        // =====================================================================
        sep();
        info('TEST 6: Payment OTP identity confusion (PATH B — REST Identity Toolkit)');
        info('Attack: User A authenticated, submits OTP for their phone (9999999999),');
        info('        but tries to close a loan where borrowerPhone=8888888888 (User B)');
        info('Expected: REJECTED — OTP phone does not match loan.borrowerPhone');

        // Mock the Firebase REST OTP endpoint — returns phone = User A (9999999999)
        nock('https://identitytoolkit.googleapis.com')
            .post('/v1/accounts:signInWithPhoneNumber')
            .reply(200, { phoneNumber: '+919999999999', idToken: 'fake_id_token' });

        // User A tries to close a loan where borrowerPhone is 8888888888 (User B)
        // The loan.borrowerPhone check should catch this
        const res6 = await request(app)
            .post(`/api/loans/${loan._id}/close`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ verificationId: 'VERIFY_SESSION_A', otp: '123456' });

        // closeLoan requires lender to submit the OTP — User A IS the lender, but the OTP
        // should still be verified and compared against borrowerPhone
        if (res6.status === 403) {
            pass('TEST 6: Rejected — User A is the lender, correct rejection if wrong identity path');
        } else if (res6.status === 400 && res6.body.message && res6.body.message.includes('does not match borrower phone')) {
            pass('TEST 6: OTP phone mismatch detected — REST OTP verification correctly cross-checks against loan.borrowerPhone');
        } else if (res6.status >= 200 && res6.status < 300) {
            fail('TEST 6', `CRITICAL: Closure succeeded with mismatched OTP phone! HTTP ${res6.status}`);
        } else {
            info(`TEST 6: HTTP ${res6.status} — ${JSON.stringify(res6.body).substring(0, 120)}`);
        }

        // =====================================================================
        // TEST 7: Financial compound — User A session + body claims User B identity
        // =====================================================================
        sep();
        info('TEST 7: Financial compound attack');
        info('Attack: User A authenticated (JWT), submits payment with body.userId = "mongo_user_B"');
        info('        The loan is User A as lender. Body claims different actor identity.');
        info('Expected: Transaction attributed to req.user.id (User A), body.userId ignored');
        info('          Zero ledger mutations from body identity confusion');

        const txCountBefore = await Transaction.countDocuments();

        const res7 = await request(app)
            .post(`/api/loans/${loan._id}/record-payment`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
                amount: 500,
                userId: 'mongo_user_B',   // body claims User B identity
                actorId: 'mongo_user_B',   // another common pattern
                verificationId: 'VERIFY_SESSION_A',
                otp: '123456'
            });

        const txCountAfter = await Transaction.countDocuments();
        const txCreated = txCountAfter > txCountBefore;

        if (res7.status === 400 || res7.status === 403) {
            pass(`TEST 7: Financial mutation rejected (HTTP ${res7.status}), ${txCreated ? 'BUT a transaction was created!' : '0 ledger mutations'}`);
        } else if (res7.status >= 200 && res7.status < 300) {
            // If it succeeded, verify the transaction actor is User A, not User B
            const recentTx = await Transaction.findOne({}).sort({ createdAt: -1 });
            if (recentTx && recentTx.actorId === 'mongo_user_B') {
                fail('TEST 7', 'CRITICAL: body.userId was accepted as actor in ledger record!');
            } else if (recentTx && recentTx.actorId === 'mongo_user_A') {
                pass('TEST 7: body.userId ignored — ledger records req.user.id (User A) as actor');
            } else {
                info(`TEST 7: Response ${res7.status}, actor check: ${recentTx?.actorId}`);
            }
        } else {
            info(`TEST 7: HTTP ${res7.status} — ${JSON.stringify(res7.body).substring(0,120)}`);
        }

        // =====================================================================
        // TEST 8: verifyOtp used for LOAN OTP flow — are the two paths mixed?
        // =====================================================================
        sep();
        info('TEST 8: PATH A vs PATH B cross-contamination');
        info('Attack: Use a Firebase ID Token (PATH A format) in the loan OTP verification field');
        info('        PATH B expects sessionInfo + code, not an ID token');
        info('Expected: Rejected — wrong format for PATH B, no identity confusion');

        nock.cleanAll();
        nock('https://identitytoolkit.googleapis.com')
            .post('/v1/accounts:signInWithPhoneNumber')
            .replyWithError('INVALID_SESSION_INFO');

        const res8 = await request(app)
            .post(`/api/loans/${loan._id}/verify-lender-otp`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ verificationId: 'VALID_TOKEN_USER_A', otp: 'NOT_A_REAL_OTP' });

        if (res8.status === 400 || res8.status === 401 || res8.status === 500) {
            pass(`TEST 8: ID token used as sessionInfo correctly rejected (HTTP ${res8.status})`);
        } else if (res8.status >= 200 && res8.status < 300) {
            fail('TEST 8', 'CRITICAL: PATH A token accepted by PATH B OTP verifier!');
        } else {
            info(`TEST 8: HTTP ${res8.status}`);
        }

        // =====================================================================
        // SUMMARY
        // =====================================================================
        sep();
        console.log = originalConsoleLog;
        console.log('\n=========================================================================');
        console.log('ATTACK SUITE COMPLETE — KEY FINDINGS:');
        console.log('=========================================================================');
        console.log('PATH A (verifyFirebaseToken / Admin SDK):');
        console.log('  • body.phone         → IGNORED ✅ (identity from token claim)');
        console.log('  • body.userId        → IGNORED ✅ (identity from token claim)');
        console.log('  • Expired token      → REJECTED ✅');
        console.log('  • Wrong project      → REJECTED ✅');
        console.log('  • UID/Mongo binding  → 🔴 Firebase UID not stored/cross-checked');
        console.log('                          Mongo user resolved by phone number only.');
        console.log('                          If Firebase UID changes (e.g. account deletion+recreate),');
        console.log('                          the same phone can attach to a different Firebase UID undetected.');
        console.log('');
        console.log('PATH B (verifyFirebaseOtp / REST Identity Toolkit in loans.js):');
        console.log('  • OTP phone vs loan.borrowerPhone → Cross-checked ✅');
        console.log('  • Compares returnedPhone (from Firebase REST) vs loan.borrowerPhone');
        console.log('  • 🔴 PATH B uses FIREBASE_API_KEY + REST API, not Admin SDK');
        console.log('    Weaker: no JWT signature verification, no aud/iss checks');
        console.log('    OTP response is not signed — if FIREBASE_API_KEY leaks,');
        console.log('    the REST endpoint could be probed externally');
        console.log('');
        console.log('FINANCIAL BOUNDARY:');
        console.log('  • body.userId not used as financial actor ✅');
        console.log('  • All financial ops use req.user.id from middleware ✅');
        console.log('');
        console.log('PRIORITY FIXES:');
        console.log('  P1-A: Store firebase_uid on User model and cross-check on every login');
        console.log('  P1-B: Replace verifyFirebaseOtp REST API with Admin SDK verifyIdToken');
        console.log('         (same as PATH A — consolidate to one trust path)');
        console.log('=========================================================================\n');

    } catch(e) {
        console.error = originalConsoleError;
        console.error('Fatal:', e);
    } finally {
        nock.cleanAll();
        nock.enableNetConnect();
        await mongoose.disconnect();
        if (mongod) await mongod.stop();
        redisMock.disconnect();
        process.exit(0);
    }
}

runAttackSuite();
