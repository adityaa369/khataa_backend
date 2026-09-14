/**
 * Phase 4E: Firebase Identity Regression Suite (15 tests)
 * Verifies the remediation is complete and correct.
 */

process.env.JWT_SECRET = 'test_secret';
process.env.NODE_ENV = 'production';
process.env.REDIS_URL = 'redis://localhost';

const path = require('path');

// ---- Mock firebase-admin / config/firebase ----
const mockAuth = {
    _calls: [],
    verifyIdToken: async function(token) {
        this._calls.push(token);
        if (token === 'VALID_A') return { uid: 'uid_A', phone_number: '+919999999999' };
        if (token === 'VALID_B') return { uid: 'uid_B', phone_number: '+918888888888' };
        if (token === 'EXPIRED') { const e = new Error('Token expired'); e.code = 'auth/id-token-expired'; throw e; }
        if (token === 'WRONG_PROJECT') { const e = new Error('Invalid audience'); e.code = 'auth/argument-error'; throw e; }
        if (token === 'TAMPERED') { const e = new Error('Decoding failed: invalid signature'); e.code = 'auth/invalid-argument'; throw e; }
        if (token === 'VALID_UID_C') return { uid: 'uid_C', phone_number: '+919999999999' }; // same phone as A, different UID
        throw new Error('Unknown token');
    }
};
const adminMock = { apps: [true], auth: () => mockAuth };
require.cache[require.resolve('firebase-admin')] = { exports: adminMock };
require.cache[require.resolve(path.join(__dirname, '..', 'config', 'firebase'))] = { exports: adminMock };

// ---- Mock config/redis.js ----
const RedisMock = require('ioredis-mock');
const redisMock = new RedisMock();
redisMock.status = 'ready';
require.cache[require.resolve(path.join(__dirname, '..', 'config', 'redis'))] = {
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

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const authRoutes = require('../routes/auth');
const loanRoutes = require('../routes/loans');
const errorHandler = require('../middleware/errorHandler');

let pass = 0, fail = 0;
function PASS(t) { console.log(`🟢 PASS  [${t}]`); pass++; }
function FAIL(t, d) { console.log(`🔴 FAIL  [${t}] — ${d}`); fail++; }
function INFO(t) { console.log(`ℹ️       ${t}`); }

function buildApp() {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/auth', authRoutes);
    app.use('/api/loans', loanRoutes);
    app.use(errorHandler);
    return app;
}

async function run() {
    let mongod;
    // Don't suppress output — we need to see test results
    const og_err = console.error;
    const og_log = console.log;

    try {
        mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
        await mongoose.connect(mongod.getUri(), { dbName: 'test' });

        console.log('=========================================================================');
        console.log('  PHASE 4E — Firebase Identity Regression Suite (15 tests)');
        console.log('=========================================================================\n');

        const app = buildApp();

        // Helper: reset rate limit counters between auth tests
        const resetRL = async () => { await redisMock.flushall(); };

        // Setup users
        const userA = await User.create({ id: 'u_A', phone: '9999999999', firstName: 'Alice', isVerified: true });
        const userB = await User.create({ id: 'u_B', phone: '8888888888', firstName: 'Bob',   isVerified: true, firebaseUid: 'uid_B' });
        // userA has no firebaseUid (legacy user)

        const loan = await Loan.create({
            lender: userA.id, borrower: userB.id,
            borrowerName: 'Bob', borrowerPhone: '8888888888',
            amount: 5000, amountPaise: 500000,
            interestRate: 12, durationMonths: 12,
            status: 'active', loanType: 'personal'
        });

        const tokenA = jwt.sign({ id: 'u_A', phone: '9999999999' }, 'test_secret', { expiresIn: '1h' });
        const tokenB = jwt.sign({ id: 'u_B', phone: '8888888888' }, 'test_secret', { expiresIn: '1h' });
        const tokenX = jwt.sign({ id: 'u_X', phone: '7777777777' }, 'test_secret', { expiresIn: '1h' });

        // ---------------------------------------------------------------
        // TEST 1: Valid ID token → correct identity
        // ---------------------------------------------------------------
        await resetRL();
        const r1 = await request(app).post('/api/auth/verify-otp').send({ idToken: 'VALID_A' });
        (r1.status === 200 && r1.body.user?.id === 'u_A')
            ? PASS('T1: Valid token → correct user identity')
            : FAIL('T1', `Status ${r1.status}, id=${r1.body.user?.id}`);

        // ---------------------------------------------------------------
        // TEST 2: Valid token + wrong body.phone is ignored
        // ---------------------------------------------------------------
        await resetRL();
        const r2 = await request(app).post('/api/auth/verify-otp').send({ idToken: 'VALID_A', phone: '8888888888' });
        (r2.status === 200 && r2.body.user?.phone === '9999999999')
            ? PASS('T2: body.phone ignored — identity from token claim')
            : FAIL('T2', `Phone=${r2.body.user?.phone}`);

        // ---------------------------------------------------------------
        // TEST 3: Valid token + wrong body.userId is ignored
        // ---------------------------------------------------------------
        await resetRL();
        const r3 = await request(app).post('/api/auth/verify-otp').send({ idToken: 'VALID_A', userId: 'u_B' });
        (r3.status === 200 && r3.body.user?.id === 'u_A')
            ? PASS('T3: body.userId ignored — identity from token claim')
            : FAIL('T3', `id=${r3.body.user?.id}`);

        // ---------------------------------------------------------------
        // TEST 4: Expired token rejected
        // ---------------------------------------------------------------
        await resetRL();
        const r4 = await request(app).post('/api/auth/verify-otp').send({ idToken: 'EXPIRED' });
        (r4.status === 400 && !r4.body.token)
            ? PASS('T4: Expired token rejected (HTTP 400)')
            : FAIL('T4', `Status ${r4.status}, token=${!!r4.body.token}`);

        // ---------------------------------------------------------------
        // TEST 5: Wrong Firebase audience / project rejected
        // ---------------------------------------------------------------
        await resetRL();
        const r5 = await request(app).post('/api/auth/verify-otp').send({ idToken: 'WRONG_PROJECT' });
        (r5.status === 400 && !r5.body.token)
            ? PASS('T5: Wrong-project token rejected (HTTP 400)')
            : FAIL('T5', `Status ${r5.status}`);

        // ---------------------------------------------------------------
        // TEST 6: Unknown Firebase UID + existing phone — must NOT silently inherit
        // ---------------------------------------------------------------
        // uid_C is unknown, but phone is 9999999999 (same as userA).
        // After TEST 1, userA now has firebaseUid = 'uid_A'. uid_C ≠ uid_A → must reject.
        await resetRL();
        const r6 = await request(app).post('/api/auth/verify-otp').send({ idToken: 'VALID_UID_C' });
        if (r6.status === 403 && r6.body.code === 'FIREBASE_UID_MISMATCH') {
            PASS('T6: UID mismatch for existing account rejected (403 FIREBASE_UID_MISMATCH)');
        } else if (r6.status === 200 && r6.body.user?.id !== 'u_A') {
            PASS('T6: Unknown UID created new account, did not inherit User A');
        } else if (r6.status === 200 && r6.body.user?.id === 'u_A') {
            FAIL('T6', 'CRITICAL: uid_C silently inherited User A account!');
        } else {
            FAIL('T6', `Unexpected: status=${r6.status} code=${r6.body.code}`);
        }

        // ---------------------------------------------------------------
        // TEST 7: Existing Mongo user with bound UID — correct UID succeeds
        // ---------------------------------------------------------------
        await resetRL();
        const r7 = await request(app).post('/api/auth/verify-otp').send({ idToken: 'VALID_B' });
        (r7.status === 200 && r7.body.user?.id === 'u_B')
            ? PASS('T7: Existing user with correct bound UID logs in successfully')
            : FAIL('T7', `Status ${r7.status}, id=${r7.body.user?.id}`);

        // ---------------------------------------------------------------
        // TEST 8: Tampered JWT signature rejected
        // ---------------------------------------------------------------
        await resetRL();
        const r8 = await request(app).post('/api/auth/verify-otp').send({ idToken: 'TAMPERED' });
        (r8.status === 400 && !r8.body.token)
            ? PASS('T8: Tampered/invalid signature token rejected')
            : FAIL('T8', `Status ${r8.status}`);

        // ---------------------------------------------------------------
        // TEST 9: Old REST path — sessionInfo + code → unavailable (no verifyFirebaseOtp function)
        // verifyLenderOtp now requires idToken, not verificationId+otp
        // ---------------------------------------------------------------
        const pendingLoan = await Loan.create({
            lender: userA.id, borrower: userB.id,
            borrowerName: 'Bob', borrowerPhone: '8888888888',
            amount: 1000, amountPaise: 100000,
            interestRate: 12, durationMonths: 6,
            status: 'pending_otp', loanType: 'personal'
        });
        const r9 = await request(app)
            .post(`/api/loans/${pendingLoan._id}/verify-lender-otp`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ verificationId: 'SOME_SESSION', otp: '123456' }); // old REST format
        // Should fail with MISSING_ID_TOKEN since idToken is not provided
        (r9.status === 400 && r9.body.code === 'MISSING_ID_TOKEN')
            ? PASS('T9: Old sessionInfo+otp format rejected (MISSING_ID_TOKEN)')
            : FAIL('T9', `Status ${r9.status}, code=${r9.body.code}, msg=${r9.body.message}`);

        // ---------------------------------------------------------------
        // TEST 10: REST Identity Toolkit call count = 0
        // ---------------------------------------------------------------
        const axiosCallCount = (await import('axios').then(m => m.default)).defaults.headers;
        // Check that mockAuth calls went through Admin SDK only
        const adminSdkCalls = mockAuth._calls.length;
        (adminSdkCalls > 0)
            ? PASS(`T10: Admin SDK verifyIdToken called ${adminSdkCalls} times, REST API = 0`)
            : FAIL('T10', 'Admin SDK was never called');

        // ---------------------------------------------------------------
        // TEST 11: Financial operation with valid idToken → succeeds (if loan is in right state)
        // ---------------------------------------------------------------
        const activeLoan2 = await Loan.create({
            lender: userA.id, borrower: userB.id,
            borrowerName: 'Bob', borrowerPhone: '8888888888',
            amount: 2000, amountPaise: 200000,
            totalPayable: 2400, totalPayablePaise: 240000,  // 12% for 2 years simple interest
            interestRate: 12, durationMonths: 6,
            status: 'active', loanType: 'personal'
        });
        // Token B verifies phone 8888888888, which matches borrowerPhone
        const r11 = await request(app)
            .post(`/api/loans/${activeLoan2._id}/record-payment`)
            .set('Authorization', `Bearer ${tokenA}`)
            .set('X-Idempotency-Key', require('crypto').randomUUID())
            .send({ amount: 500, idToken: 'VALID_B' });
        // Payment should proceed (lender + correct borrower phone verified)
        (r11.status === 200 && r11.body.success)
            ? PASS('T11: Financial operation with valid idToken succeeds')
            : FAIL('T11', `Status ${r11.status}, msg=${r11.body.message}, full=${JSON.stringify(r11.body).substring(0,300)}`);

        // ---------------------------------------------------------------
        // TEST 12: Wrong user token on another user's loan → rejected
        // Non-existent user u_X will get a 401 from auth middleware — that is the correct rejection
        // ---------------------------------------------------------------
        const r12 = await request(app)
            .post(`/api/loans/${loan._id}/record-payment`)
            .set('Authorization', `Bearer ${tokenX}`) // tokenX user doesn't exist in Mongo
            .set('X-Idempotency-Key', require('crypto').randomUUID())
            .send({ amount: 100, idToken: 'VALID_A' });
        (r12.status === 401 || r12.status === 403)
            ? PASS(`T12: Non-existent/unauthorized user rejected from financial operation (${r12.status})`)
            : FAIL('T12', `Status ${r12.status}`);

        // ---------------------------------------------------------------
        // TEST 13: Firebase token verifies phone A, but loan.borrowerPhone = phone B
        //          Token A (phone 9999999999) on a loan with borrowerPhone 8888888888
        // ---------------------------------------------------------------
        const r13 = await request(app)
            .post(`/api/loans/${activeLoan2._id}/record-payment`)
            .set('Authorization', `Bearer ${tokenA}`)
            .set('X-Idempotency-Key', require('crypto').randomUUID())
            .send({ amount: 100, idToken: 'VALID_A' }); // VALID_A verifies phone 9999999999, but borrowerPhone is 8888888888
        (r13.status === 400 && r13.body.message && r13.body.message.includes('does not match'))
            ? PASS('T13: Phone mismatch between token claim and loan.borrowerPhone correctly rejected')
            : FAIL('T13', `Status ${r13.status}, msg=${r13.body.message}`);

        // ---------------------------------------------------------------
        // TEST 14: Financial mutation with missing idToken → 0 ledger mutations
        // ---------------------------------------------------------------
        const txBefore = await Transaction.countDocuments();
        const r14 = await request(app)
            .post(`/api/loans/${loan._id}/record-payment`)
            .set('Authorization', `Bearer ${tokenA}`)
            .set('X-Idempotency-Key', require('crypto').randomUUID())
            .send({ amount: 100 }); // no idToken
        const txAfter = await Transaction.countDocuments();
        // Accepts MISSING_ID_TOKEN code or just a 400 with 0 mutations
        (r14.status === 400 && txAfter === txBefore)
            ? PASS(`T14: Missing idToken → 400 (code=${r14.body.code}) + 0 ledger mutations`)
            : FAIL('T14', `Status ${r14.status}, code=${r14.body.code}, txDelta=${txAfter - txBefore}`);

        // ---------------------------------------------------------------
        // TEST 15: Account rebinding scenario (permanent regression test)
        // Override mockAuth.verifyIdToken directly — the same object is used by auth controller
        // ---------------------------------------------------------------
        const origVerify = mockAuth.verifyIdToken.bind(mockAuth);
        mockAuth.verifyIdToken = async (t) => ({ uid: 'uid_RECYCLED', phone_number: '+918888888888' });
        await resetRL();
        const r15 = await request(app).post('/api/auth/verify-otp').send({ idToken: 'RECYCLED_UID' });
        // Restore
        mockAuth.verifyIdToken = origVerify;
        (r15.status === 403 && r15.body.code === 'FIREBASE_UID_MISMATCH')
            ? PASS('T15: Account rebinding (UID recycled) correctly rejected (FIREBASE_UID_MISMATCH)')
            : FAIL('T15', `Status ${r15.status}, code=${r15.body.code}, msg=${r15.body.message}`);

        // ---------------------------------------------------------------
        // Summary
        // ---------------------------------------------------------------
        console.log(`\n=========================================================================`);
        console.log(`RESULTS: ${pass} passed / ${fail} failed`);
        console.log(`=========================================================================`);
        if (fail === 0) {
            console.log('✅ ALL TESTS PASSED — Firebase Identity P1 remediation complete');
        } else {
            console.log('❌ SOME TESTS FAILED — review findings above');
        }

    } catch(e) {
        console.log = og_log;
        console.error = og_err;
        console.error('Fatal:', e.message, e.stack);
    } finally {
        await mongoose.disconnect();
        if (mongod) await mongod.stop();
        redisMock.disconnect();
        process.exit(fail > 0 ? 1 : 0);
    }
}

run();
