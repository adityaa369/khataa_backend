const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');

let mongoServer;
let app;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.JWT_SECRET = 'testsecret';
    process.env.NODE_ENV = 'test';
    
    app = require('../../index'); // assuming index.js exports app
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

const generateToken = (userId, phone) => {
    return jwt.sign({ id: userId, phone }, process.env.JWT_SECRET);
};

describe('Borrower Consent Workflow', () => {
    let lenderToken;
    let borrowerToken;
    let otherToken;
    let loanId;
    let intentId;

    beforeAll(async () => {
        const User = require('../../models/User');
        await User.create({ id: 'lender1', phone: '1111111111', role: 'user', kycStatus: 'verified' });
        await User.create({ id: 'borrower1', phone: '2222222222', role: 'user', kycStatus: 'verified' });
        await User.create({ id: 'other1', phone: '3333333333', role: 'user', kycStatus: 'verified' });

        lenderToken = generateToken('lender1', '1111111111');
        borrowerToken = generateToken('borrower1', '2222222222');
        otherToken = generateToken('other1', '3333333333');
    });

    it('creates agreement pending, not active, with notification outbox', async () => {
        const res = await request(app)
            .post('/api/loans')
            .set('Authorization', `Bearer ${lenderToken}`)
            .send({
                borrower_phone: '2222222222',
                borrower_name: 'Borrower One',
                amount: 1000,
                interest_rate: 0,
                duration_months: 6,
                type: 'personal'
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.loan.status).toBe('pending_approval');
        
        loanId = res.body.loan._id;

        // Verify outbox
        const NotificationOutbox = require('../../models/NotificationOutbox');
        const outbox = await NotificationOutbox.findOne({ recipientUserId: 'borrower1' });
        expect(outbox).toBeDefined();
        expect(outbox.payload.intentId).toBeDefined();
        intentId = outbox.payload.intentId;
    });

    it('rejects missing consent', async () => {
        const res = await request(app)
            .post(`/api/loans/${loanId}/verify`)
            .set('Authorization', `Bearer ${borrowerToken}`)
            .send({}); // Missing intentId
        expect(res.status).toBe(400);
    });

    it('activates successfully with correct consent', async () => {
        const res = await request(app)
            .post(`/api/loans/${loanId}/verify`)
            .set('Authorization', `Bearer ${borrowerToken}`)
            .send({ intentId });
        expect(res.status).toBe(200);
        
        const Loan = require('../../models/Loan');
        const loan = await Loan.findById(loanId);
        expect(loan.status).toBe('active');
        expect(loan.principalOutstandingPaise).toBe(100000);
    });
});
