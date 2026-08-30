const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Redis = require('ioredis-mock');
const jwt = require('jsonwebtoken');

process.env.REDIS_URL = 'redis://localhost:6379';
const redisMock = new Redis();
redisMock.status = 'ready';

const configRedisPath = require.resolve('../config/redis');
const realConfigRedis = require('../config/redis');
require.cache[configRedisPath] = {
    id: configRedisPath,
    filename: configRedisPath,
    loaded: true,
    exports: { ...realConfigRedis, getRedisClient: () => redisMock, isRedisAvailable: () => true }
};

const utilsRedisPath = require.resolve('../utils/redisClient');
const realUtilsRedis = require('../utils/redisClient');
require.cache[utilsRedisPath] = {
    id: utilsRedisPath,
    filename: utilsRedisPath,
    loaded: true,
    exports: { ...realUtilsRedis, getRedisClient: () => redisMock, isRedisAvailable: () => true }
};

const User = require('../models/User');
const Loan = require('../models/Loan');
const NotificationOutbox = require('../models/NotificationOutbox');
const loanRoutes = require('../routes/loans');
const authRoutes = require('../routes/auth');
const errorHandler = require('../middleware/errorHandler');

async function runInfoDisclosureAudit() {
    let mongod;
    try {
        mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
        await mongoose.connect(mongod.getUri(), { dbName: 'khataa' });

        process.env.JWT_SECRET = 'secret';
        process.env.NODE_ENV = 'production';

        const lender = await User.create({ id: 'lender_id', phone: '9999999999', email: 'lender@test.com', firstName: 'Lender', isVerified: true, isEmailVerified: true, pan: 'ABCDE1234F', fcmToken: 'token_123', password: 'hashedpassword' });
        const borrower = await User.create({ id: 'borrower_id', phone: '8888888888', email: 'borrower@test.com', firstName: 'Borrower', isVerified: true, isEmailVerified: true });
        
        const loan = await Loan.create({
            lender: lender.id,
            borrower: borrower.id,
            borrowerName: borrower.firstName,
            borrowerPhone: borrower.phone,
            amount: 5000,
            amountPaise: 500000,
            durationMonths: 12,
            status: 'active',
            principalOutstandingPaise: 500000
        });

        const token = jwt.sign({ id: lender.id }, 'secret', { expiresIn: '1h' });

        const app = express();
        app.use(express.json());
        app.use('/api/auth', authRoutes);
        app.use('/api/loans', (req, res, next) => {
            req.user = lender; // mock
            next();
        }, loanRoutes);
        
        // Add a route to deliberately throw an error to test the error handler
        app.get('/api/trigger-error', (req, res, next) => {
            next(new Error('Sensitive database connection failed to 10.0.0.5'));
        });

        // 404 handler
        app.use((req, res, next) => {
            res.status(404).json({ success: false, message: 'Not found' });
        });

        app.use(errorHandler);

        console.log("=========================================================================");
        console.log("       PHASE 4E: INFORMATION DISCLOSURE ATTACK SUITE                     ");
        console.log("=========================================================================\n");

        const report = [];

        // 1. API Response Leakage (GET /me)
        const resMe = await request(app).get('/api/auth/me').set('Authorization', 'Bearer ' + token);
        const userObj = resMe.body.user || resMe.body.data || {};
        const leakedAuthFields = ['password', 'pan', 'fcmToken', '__v', 'emailVerificationToken', 'passwordResetToken'].filter(f => userObj[f] !== undefined);
        report.push({
            attack: 'API response leakage (Auth /me)',
            endpoint: 'GET /api/auth/me',
            actual: `Returned fields: ${Object.keys(userObj).join(', ')}`,
            leaked: leakedAuthFields.length > 0 ? leakedAuthFields.join(', ') : 'None',
            httpStatus: resMe.status,
            result: leakedAuthFields.length === 0 ? '🟢 PASS' : '🔴 FAIL'
        });

        // 2. Financial API excessive fields (GET /loans/given)
        const resLoan = await request(app).get('/api/loans/given').set('Authorization', 'Bearer ' + token);
        const loansArr = resLoan.body.loans || resLoan.body.data || [];
        const loanObj = loansArr[0] || {};
        const leakedLoanFields = ['__v', 'lender.password', 'borrower.password', 'lender.fcmToken', 'borrower.fcmToken'].filter(f => {
            if (f.includes('.')) {
                const [p, c] = f.split('.');
                return loanObj[p] && loanObj[p][c] !== undefined;
            }
            return loanObj[f] !== undefined;
        });
        report.push({
            attack: 'Financial API excessive fields',
            endpoint: 'GET /api/loans/given',
            actual: `Returned fields: ${Object.keys(loanObj).join(', ')}`,
            leaked: leakedLoanFields.length > 0 ? leakedLoanFields.join(', ') : 'None',
            httpStatus: resLoan.status,
            result: leakedLoanFields.length === 0 ? '🟢 PASS' : '🔴 FAIL'
        });

        // 3. Error/stack-trace leakage
        const resErr = await request(app).get('/api/trigger-error').set('Authorization', 'Bearer ' + token);
        const errLeaked = resErr.body.stack || (resErr.body.message && resErr.body.message.includes('10.0.0.5'));
        report.push({
            attack: 'Error/stack-trace leakage',
            endpoint: 'GET /api/trigger-error',
            actual: JSON.stringify(resErr.body),
            leaked: errLeaked ? 'Stack trace or sensitive message leaked' : 'None',
            httpStatus: resErr.status,
            result: !errLeaked ? '🟢 PASS' : '🔴 FAIL'
        });

        // 4. Unknown route leakage
        const res404 = await request(app).get('/api/does-not-exist');
        const leak404 = res404.text.includes('Cannot GET') || res404.text.includes('<html');
        report.push({
            attack: 'Unknown route leakage',
            endpoint: 'GET /api/does-not-exist',
            actual: res404.text.substring(0, 100),
            leaked: leak404 ? 'Express default HTML 404 leaked' : 'None',
            httpStatus: res404.status,
            result: !leak404 ? '🟢 PASS' : '🔴 FAIL'
        });

        // 5. Account Enumeration (Forgot Password)
        const resForgot1 = await request(app).post('/api/auth/forgot-password').send({ phone: '9999999999' }); // Exists
        const resForgot2 = await request(app).post('/api/auth/forgot-password').send({ phone: '1111111111' }); // Does not exist
        const enumLeaked = resForgot1.status !== resForgot2.status || resForgot1.body.message !== resForgot2.body.message;
        report.push({
            attack: 'User/account enumeration via Forgot Password',
            endpoint: 'POST /api/auth/forgot-password',
            actual: `Exists: ${resForgot1.status} ${resForgot1.body.message} | Not Exists: ${resForgot2.status} ${resForgot2.body.message}`,
            leaked: enumLeaked ? 'Different responses reveal account existence' : 'None',
            httpStatus: `${resForgot1.status} / ${resForgot2.status}`,
            result: !enumLeaked ? '🟢 PASS' : '🔴 FAIL'
        });

        // Print Report
        report.forEach(r => {
            console.log(`Attack: ${r.attack}`);
            console.log(`Endpoint: ${r.endpoint}`);
            console.log(`Actual: ${r.actual}`);
            console.log(`Sensitive information exposed: ${r.leaked}`);
            console.log(`HTTP status: ${r.httpStatus}`);
            console.log('----------------------------------------------------------------------');
        });

    } catch (e) {
        console.error(e);
    } finally {
        if (mongoose.connection) await mongoose.disconnect();
        if (mongod) await mongod.stop();
        redisMock.disconnect();
        process.exit(0);
    }
}
runInfoDisclosureAudit();
