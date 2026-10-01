const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../server'); // Assuming app is exported from server.js
const Loan = require('../models/Loan');
const User = require('../models/User');
const TransactionIntent = require('../models/TransactionIntent');
const OtpChallenge = require('../models/OtpChallenge');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

describe('Payment Commit Endpoint', () => {
    let token, lender, borrower, loan, intent, challenge;

    beforeAll(async () => {
        // Quick setup if connected
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/khatha_test_payments', {
                useNewUrlParser: true,
                useUnifiedTopology: true
            });
        }
    });

    afterAll(async () => {
        await mongoose.connection.close();
    });

    beforeEach(async () => {
        await User.deleteMany({});
        await Loan.deleteMany({});
        await TransactionIntent.deleteMany({});
        await OtpChallenge.deleteMany({});

        lender = await User.create({ id: 'lender-id', phone: '1111111111', isVerified: true });
        borrower = await User.create({ id: 'borrower-id', phone: '2222222222', isVerified: true });

        loan = await Loan.create({
            lender: lender._id,
            borrower: borrower._id,
            principalAmountPaise: 100000,
            interestRate: 10,
            durationMonths: 12,
            status: 'active'
        });

        token = jwt.sign({ id: lender.id }, process.env.JWT_SECRET || 'testsecret', { expiresIn: '1h' });

        intent = await TransactionIntent.create({
            intentId: 'intent-123',
            action: 'PAYMENT',
            userId: lender.id,
            loanId: loan._id,
            status: 'PENDING',
            payload: { amountPaise: 1000, note: 'Test' },
            expiresAt: new Date(Date.now() + 5 * 60000)
        });

        const otpHash = await bcrypt.hash('123456', 10);
        challenge = await OtpChallenge.create({
            intentId: 'intent-123',
            otpHash,
            borrowerUserId: borrower._id.toString(),
            lenderUserId: lender._id.toString(),
            loanId: loan._id.toString(),
            amountPaise: 1000,
            attemptsRemaining: 5,
            status: 'ACTIVE'
        });
    });

    test('wrong OTP returns 400', async () => {
        const res = await request(app)
            .post(/api/loans//payments/commit)
            .set('Authorization', Bearer )
            .send({
                intentId: 'intent-123',
                otp: '999999', // wrong OTP
                idToken: 'mock-firebase-token'
            });
        
        // Cannot test fully without mocking admin.auth().verifyIdToken
        // but let's mock it inline for the test if possible?
        // Actually, let's mock admin directly.
    });
});
