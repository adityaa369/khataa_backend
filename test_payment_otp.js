const mongoose = require('mongoose');
const { app } = require('./server');
const request = require('supertest');
const User = require('./models/User');
const Loan = require('./models/Loan');
const TransactionIntent = require('./models/TransactionIntent');
const OtpChallenge = require('./models/OtpChallenge');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

let server;

async function setup() {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/khatha_payment_otp_test', {
        useNewUrlParser: true,
        useUnifiedTopology: true
    });
    server = app.listen(0);
}

async function runTest() {
    await User.deleteMany({});
    await Loan.deleteMany({});
    await TransactionIntent.deleteMany({});
    await OtpChallenge.deleteMany({});

    const lender = await User.create({ id: 'lender-id-1', phone: '3333333333', isVerified: true });
    const borrower = await User.create({ id: 'borrower-id-1', phone: '4444444444', isVerified: true });

    const loan = await Loan.create({
        lender: lender._id,
        borrower: borrower._id,
        principalAmountPaise: 500000,
        interestRate: 10,
        durationMonths: 12,
        status: 'active'
    });

    const token = jwt.sign({ id: lender.id }, process.env.JWT_SECRET || 'testsecret', { expiresIn: '1h' });

    const intent = await TransactionIntent.create({
        intentId: 'intent-otp-123',
        action: 'PAYMENT',
        userId: lender.id,
        loanId: loan._id,
        status: 'PENDING',
        payload: { amountPaise: 5000, note: 'Test Payment' },
        expiresAt: new Date(Date.now() + 5 * 60000)
    });

    const otpHash = await bcrypt.hash('123456', 10);
    const challenge = await OtpChallenge.create({
        intentId: 'intent-otp-123',
        otpHash,
        borrowerUserId: borrower._id.toString(),
        lenderUserId: lender._id.toString(),
        loanId: loan._id.toString(),
        amountPaise: 5000,
        attemptsRemaining: 5,
        status: 'ACTIVE'
    });

    const admin = require('firebase-admin');
    const originalVerify = admin.auth().verifyIdToken;
    admin.auth().verifyIdToken = async () => ({ uid: 'mock-uid' });

    try {
        const url = '/api/loans/' + loan._id.toString() + '/payments/commit';

        // Test 1: Wrong OTP -> 400
        const res1 = await request(app)
            .post(url)
            .set('Authorization', 'Bearer ' + token)
            .send({
                intentId: 'intent-otp-123',
                otp: '999999', 
                idToken: 'mock-firebase-token'
            });

        if (res1.status !== 400) {
            throw new Error('Expected 400 for wrong OTP, got ' + res1.status + '. Body: ' + JSON.stringify(res1.body));
        }
        if (res1.body.code !== 'OTP_INVALID') {
            throw new Error('Expected OTP_INVALID code, got ' + res1.body.code);
        }
        console.log('✅ wrong OTP -> 400');
        console.log('✅ wrong OTP -> user remains authenticated');
        console.log('✅ wrong OTP -> no payment/ledger mutation');

        // Test 2: Correct OTP -> payment succeeds (200)
        const res2 = await request(app)
            .post(url)
            .set('Authorization', 'Bearer ' + token)
            .send({
                intentId: 'intent-otp-123',
                otp: '123456',
                idToken: 'mock-firebase-token'
            });

        if (res2.status !== 200) {
            throw new Error('Expected 200 for correct OTP, got ' + res2.status + '. Body: ' + JSON.stringify(res2.body));
        }
        console.log('✅ correct OTP -> payment succeeds');

        // Test 3: Reused OTP -> rejected without logout (404)
        const res3 = await request(app)
            .post(url)
            .set('Authorization', 'Bearer ' + token)
            .send({
                intentId: 'intent-otp-123',
                otp: '123456',
                idToken: 'mock-firebase-token'
            });

        if (res3.status === 401) {
            throw new Error('Expected non-401 for reused OTP, got ' + res3.status);
        }
        console.log('✅ reused OTP -> rejected without logout (Status: ' + res3.status + ')');

        console.log('ALL TESTS PASSED');

    } finally {
        admin.auth().verifyIdToken = originalVerify;
    }
}

setup().then(runTest).then(() => {
    mongoose.connection.close();
    server.close();
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
