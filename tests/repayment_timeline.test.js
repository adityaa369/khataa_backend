jest.setTimeout(30000);
const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../server');
const User = require('../models/User');
const Loan = require('../models/Loan');

describe('Repayment Timeline Projection (F.4.2)', () => {
    let tokenLender, tokenBorrower, tokenUnrelated;
    let userLender, userBorrower, userUnrelated;
    let testLoanId;

    beforeAll(async () => {
        await User.deleteMany();
        await Loan.deleteMany();

        userLender = await User.create({ firstName: 'L', lastName: 'L', phone: '+910000000001', password: 'P' });
        userBorrower = await User.create({ firstName: 'B', lastName: 'B', phone: '+910000000002', password: 'P' });
        userUnrelated = await User.create({ firstName: 'U', lastName: 'U', phone: '+910000000003', password: 'P' });

        const resL = await request(app).post('/api/auth/login').send({ phone: '+910000000001', password: 'P' });
        tokenLender = resL.body.token;
        const resB = await request(app).post('/api/auth/login').send({ phone: '+910000000002', password: 'P' });
        tokenBorrower = resB.body.token;
        const resU = await request(app).post('/api/auth/login').send({ phone: '+910000000003', password: 'P' });
        tokenUnrelated = resU.body.token;

        // Base anchor: August 10, 2026, 12:00:00Z
        const anchorDate = new Date('2026-08-10T12:00:00.000Z');

        const loan = await Loan.create({
            lender: userLender._id,
            borrower: userBorrower._id,
            borrowerName: 'B',
            borrowerPhone: '+910000000002',
            amount: 5000,
            amountPaise: 500000,
            durationMonths: 2,
            status: 'active',
            activatedAt: anchorDate,
            transactions: [
                { type: 'payment', amount: 1000, amountPaise: 100000, recordedAt: new Date('2026-08-15T12:00:00.000Z') }, // Month 1
                { type: 'payment', amount: 2000, amountPaise: 200000, recordedAt: new Date('2026-09-15T12:00:00.000Z') }, // Month 2
                { type: 'payment', amount: 500, amountPaise: 50000, recordedAt: new Date('2026-09-20T12:00:00.000Z') }, // Month 2
                { type: 'payment', amount: 1000, amountPaise: 100000, recordedAt: new Date('2026-10-10T12:00:00.000Z') }, // Exactly boundary of Month 2 end -> goes to post-term
                { type: 'payment', amount: 500, amountPaise: 50000, recordedAt: new Date('2026-11-01T12:00:00.000Z') }, // Month 3+ (Post-term)
            ]
        });
        testLoanId = loan._id;
        
        await Loan.create({
            _id: new mongoose.Types.ObjectId('6a8ca52aee662a987929c999'),
            lender: userLender._id,
            borrowerName: 'C',
            borrowerPhone: '+910000000009',
            amount: 5000,
            durationMonths: 2,
            status: 'active',
            loanType: 'chit'
        });
    });

    afterAll(async () => {
        await mongoose.connection.close();
    });

    test('Lender can view timeline', async () => {
        const res = await request(app).get(`/api/loans/${testLoanId}/repayment-timeline`).set('Authorization', `Bearer ${tokenLender}`);
        expect(res.status).toBe(200);
        expect(res.body.trackingEnabled).toBe(true);
    });

    test('Borrower can view timeline', async () => {
        const res = await request(app).get(`/api/loans/${testLoanId}/repayment-timeline`).set('Authorization', `Bearer ${tokenBorrower}`);
        expect(res.status).toBe(200);
    });

    test('Unrelated user gets 403', async () => {
        const res = await request(app).get(`/api/loans/${testLoanId}/repayment-timeline`).set('Authorization', `Bearer ${tokenUnrelated}`);
        expect(res.status).toBe(403);
    });

    test('Timeline generates exactly durationMonths periods', async () => {
        const res = await request(app).get(`/api/loans/${testLoanId}/repayment-timeline`).set('Authorization', `Bearer ${tokenLender}`);
        expect(res.body.data.timeline.length).toBe(2);
    });

    test('Multiple payments map correctly with calendar boundaries', async () => {
        const res = await request(app).get(`/api/loans/${testLoanId}/repayment-timeline`).set('Authorization', `Bearer ${tokenLender}`);
        const tl = res.body.data.timeline;
        
        // Month 1 (Aug 10 - Sep 9)
        expect(tl[0].periodIndex).toBe(1);
        expect(tl[0].transactions.length).toBe(1);
        expect(tl[0].totalPaidPaise).toBe(100000);
        expect(tl[0].hasPayments).toBe(true);
        expect(tl[0].status).toBe('RECORDED');

        // Month 2 (Sep 10 - Oct 9)
        expect(tl[1].periodIndex).toBe(2);
        expect(tl[1].transactions.length).toBe(2);
        expect(tl[1].totalPaidPaise).toBe(250000); // 200,000 + 50,000
    });

    test('Post-term payments are separated', async () => {
        const res = await request(app).get(`/api/loans/${testLoanId}/repayment-timeline`).set('Authorization', `Bearer ${tokenLender}`);
        expect(res.body.data.postTermTransactions.length).toBe(2);
    });

    test('Chit loans return trackingEnabled = false', async () => {
        const res = await request(app).get(`/api/loans/6a8ca52aee662a987929c999/repayment-timeline`).set('Authorization', `Bearer ${tokenLender}`);
        expect(res.status).toBe(200);
        expect(res.body.trackingEnabled).toBe(false);
        expect(res.body.reason).toBe('UNSUPPORTED_LOAN_TYPE');
    });
});

