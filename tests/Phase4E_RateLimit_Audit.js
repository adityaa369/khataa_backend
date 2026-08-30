const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Redis = require('ioredis-mock');
const jwt = require('jsonwebtoken');

// 1. Mock Redis Client BEFORE requiring the app routes/services
process.env.REDIS_URL = 'redis://localhost:6379';
const redisMock = new Redis();
redisMock.status = 'ready';

// Inject mock into config/redis
const configRedisPath = require.resolve('../config/redis');
const realConfigRedis = require('../config/redis');
require.cache[configRedisPath] = {
    id: configRedisPath,
    filename: configRedisPath,
    loaded: true,
    exports: {
        ...realConfigRedis,
        getRedisClient: () => redisMock,
        isRedisAvailable: () => true
    }
};

const utilsRedisPath = require.resolve('../utils/redisClient');
const realUtilsRedis = require('../utils/redisClient');
require.cache[utilsRedisPath] = {
    id: utilsRedisPath,
    filename: utilsRedisPath,
    loaded: true,
    exports: {
        ...realUtilsRedis,
        getRedisClient: () => redisMock,
        isRedisAvailable: () => true
    }
};

const User = require('../models/User');
const Loan = require('../models/Loan');
const TransactionIntent = require('../models/TransactionIntent');
const NotificationOutbox = require('../models/NotificationOutbox');
const loanRoutes = require('../routes/loans');
const authRoutes = require('../routes/auth');
const errorHandler = require('../middleware/errorHandler');

async function runRateLimitAudit() {
    let mongod;
    try {
        mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
        await mongoose.connect(mongod.getUri(), { dbName: 'khataa' });

        process.env.JWT_SECRET = 'secret';
        process.env.NODE_ENV = 'production';

        const lender = await User.create({ id: 'lender_id', phone: '9999999999', firstName: 'Lender', email: 'lender@example.com', isEmailVerified: true, kycStatus: 'verified', isVerified: true, password: 'password123' });
        const borrower1 = await User.create({ id: 'borrower_id1', phone: '8888888888', firstName: 'Borrower', email: 'borrower@example.com', isVerified: true, isEmailVerified: true });
        
        const loan = await Loan.create({
            lender: lender.id,
            borrower: borrower1.id,
            borrowerName: borrower1.firstName,
            borrowerPhone: borrower1.phone,
            amount: 5000,
            amountPaise: 500000,
            durationMonths: 12,
            status: 'active',
            principalOutstandingPaise: 500000
        });

        const token = jwt.sign({ id: lender.id }, 'secret', { expiresIn: '1h' });

        const app = express();
        // Trust proxy to allow header spoofing tests
        app.set('trust proxy', true);
        app.use(express.json());
        app.use('/api/auth', authRoutes);
        app.use('/api/loans', (req, res, next) => {
            req.user = lender; // simplified auth mock for loans
            next();
        }, loanRoutes);
        app.use(errorHandler);

        console.log("=========================================================================");
        console.log("       PHASE 4E: RATE LIMITS / ABUSE ATTACK SUITE                      ");
        console.log("=========================================================================\n");

        const report = [];

        // Utility to run concurrent requests
        const runConcurrent = async (reqBuilder, count) => {
            const promises = [];
            for(let i=0; i<count; i++) {
                promises.push(reqBuilder(i));
            }
            return Promise.all(promises);
        };

        // 1. 100 concurrent OTP verification attempts (auth route)
        const otpReqBuilder = () => request(app).post('/api/auth/verify-otp').send({ phone: '9999999999', idToken: 'fake' });
        const otpResults = await runConcurrent(otpReqBuilder, 100);
        const otp200s = otpResults.filter(r => r.status === 200 || r.status === 400 || r.status === 401).length;
        const otp429s = otpResults.filter(r => r.status === 429).length;

        report.push({
            attack: "100 concurrent OTP verification attempts",
            endpoint: "POST /api/auth/verify-otp",
            expected: "Strictly limited to max 3 attempts",
            actual: `${otp429s} rate limited, ${otp200s} allowed (or 401/400)`,
            result: otp429s >= 97 ? "🟢 PASS" : "🔴 FAIL"
        });

        // 2. 100 concurrent intent creation requests (via close-otp)
        const outboxBeforeClose = await NotificationOutbox.countDocuments();
        const closeOtpBuilder = () => request(app).post(`/api/loans/${loan._id}/close-otp`).set('Authorization', `Bearer ${token}`);
        const closeOtpResults = await runConcurrent(closeOtpBuilder, 100);
        const close200s = closeOtpResults.filter(r => r.status === 200).length;
        const close429s = closeOtpResults.filter(r => r.status === 429).length;
        const outboxAfterClose = await NotificationOutbox.countDocuments();

        report.push({
            attack: "100 concurrent intent creation requests via close-otp",
            endpoint: "POST /api/loans/:id/close-otp",
            expected: "Rate limited, bounded intent/notification creation",
            actual: `${close429s} rate limited, ${close200s} successful. Outbox grew by ${outboxAfterClose - outboxBeforeClose}`,
            result: close429s > 50 && (outboxAfterClose - outboxBeforeClose) < 100 ? "🟢 PASS" : "🔴 FAIL (Flood possible)"
        });

        // 3. 100 concurrent financial requests (record-payment)
        // Must use different idempotency keys to bypass idempotency guard and test rate limiter
        const finBuilder = (i) => request(app).post(`/api/loans/${loan._id}/record-payment`)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Idempotency-Key', `key_${i}`)
            .send({ intentId: 'intent_123', amount: 5000 });
        const finResults = await runConcurrent(finBuilder, 100);
        const fin200s = finResults.filter(r => r.status === 200 || r.status === 400 || r.status === 404).length;
        const fin429s = finResults.filter(r => r.status === 429).length;
        
        report.push({
            attack: "100 concurrent financial requests",
            endpoint: "POST /api/loans/:id/record-payment",
            expected: "Rate limited (financial limiter = 20/min)",
            actual: `${fin429s} rate limited, ${fin200s} non-429s (likely 400s due to invalid intent/etc)`,
            result: fin429s >= 80 ? "🟢 PASS" : "🔴 FAIL"
        });

        // 4. Header / IP spoofing bypass
        // Send 10 requests with different X-Forwarded-For headers to authLimiter (max 5)
        const spoofBuilder = (i) => request(app).post('/api/auth/login-password')
            .set('X-Forwarded-For', `192.168.1.${i}`)
            .send({ phone: '9999999999', password: 'password123' });
        const spoofResults = await runConcurrent(spoofBuilder, 10);
        const spoof200s = spoofResults.filter(r => r.status === 200 || r.status === 400 || r.status === 401).length;
        const spoof429s = spoofResults.filter(r => r.status === 429).length;

        report.push({
            attack: "Header/IP spoofing (X-Forwarded-For) on Auth",
            endpoint: "POST /api/auth/login-password",
            expected: "Spoofing IP shouldn't bypass limit for the same user/account",
            actual: `${spoof429s} rate limited, ${spoof200s} successful logins (or 401s)`,
            result: spoof429s > 0 ? "🟢 PASS" : "🔴 FAIL (Bypass achieved)"
        });

        // 5. Email resend abuse
        const resendBuilder = () => request(app).post('/api/auth/send-verification-email')
            .set('Authorization', `Bearer ${token}`);
        const resendResults = await runConcurrent(resendBuilder, 20);
        const resend429s = resendResults.filter(r => r.status === 429).length;
        const resend200s = resendResults.filter(r => r.status === 200).length;

        report.push({
            attack: "Email verification resend abuse",
            endpoint: "POST /api/auth/send-verification-email",
            expected: "Rate limited (authLimiter)",
            actual: `${resend429s} rate limited, ${resend200s} successful`,
            result: resend429s > 0 ? "🟢 PASS" : "🔴 FAIL"
        });

        // 6. 429 Contract validation
        const sample429 = finResults.find(r => r.status === 429) || otpResults.find(r => r.status === 429);
        const contractValid = sample429 && sample429.body.success === false && sample429.body.message && sample429.body.retryAfter !== undefined;
        report.push({
            attack: "429 Contract format",
            endpoint: "Any rate-limited endpoint",
            expected: "Returns structured error with retryAfter",
            actual: sample429 ? JSON.stringify(sample429.body) : "No 429 received",
            result: contractValid ? "🟢 PASS" : "🔴 FAIL"
        });

        report.forEach(a => {
            console.log(`Attack: ${a.attack}`);
            console.log(`Endpoint: ${a.endpoint}`);
            console.log(`Expected: ${a.expected}`);
            console.log(`Actual: ${a.actual}`);
            console.log(`Result: ${a.result}`);
            console.log("----------------------------------------------------------------------");
        });

    } catch (err) {
        console.error("Test Harness Error:", err);
    } finally {
        if (mongoose.connection) await mongoose.disconnect();
        if (mongod) await mongod.stop();
        redisMock.disconnect();
        process.exit(0);
    }
}

runRateLimitAudit();
