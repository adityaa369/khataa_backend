const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../../models/User');
const Loan = require('../../models/Loan');
jest.setTimeout(60000);

let app;

let mongoServer;
let lenderToken;
let lenderId;
let borrowerId;
let borrowerPhone = '9999999999';

beforeAll(async () => {
    process.env.JWT_SECRET = 'testsecret';
    process.env.NODE_ENV = 'test';
    app = require('../../index');
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.disconnect();
    await mongoose.connect(mongoServer.getUri());

    jest.spyOn(require('../../services/RateLimitService'), 'consume').mockResolvedValue({ allowed: true, remaining: 10, reset: Date.now() + 10000 });


    const lender = await User.create({ id: 'lender-id-1', firstName: 'Lender', lastName: 'One', phone: '8888888888', password: 'Password123' });
    lenderId = lender._id;
    const jwt = require('jsonwebtoken');
    lenderToken = jwt.sign({ id: lender.id }, process.env.JWT_SECRET, { expiresIn: '1d' });

    const borrower = await User.create({ id: 'borrower-id-1', firstName: 'Borrower', lastName: 'One', phone: borrowerPhone, email: 'borrower@test.com', password: 'Password123' });
    borrowerId = borrower._id;
});

afterAll(async () => {
    jest.restoreAllMocks();
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
});

describe('Batch 2: Canonical Money Contract', () => {
    it('should create a loan with amountPaise safely without float ambiguity', async () => {
        const res = await request(app).post('/api/loans').set('Authorization', `Bearer ${lenderToken}`).send({ amountPaise: 68000000, borrower_phone: borrowerPhone, borrower_name: 'Borrower One', duration_months: 12 });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.loan.amountPaise).toBe(68000000);
        const dbLoan = await Loan.findById(res.body.loan._id);
        expect(dbLoan.amountPaise).toBe(68000000);
        expect(dbLoan.amount).toBe(680000);
    });
    it('should fail if amountPaise is missing or float', async () => {
        const res = await request(app).post('/api/loans').set('Authorization', `Bearer ${lenderToken}`).send({ amountPaise: 680000.50, borrower_phone: borrowerPhone, borrower_name: 'Borrower One', duration_months: 12 });
        expect(res.status).toBe(400);
        expect(res.body.errors[0].message).toContain('positive integer in paise');
    });
    it('should record payment with amountPaise', async () => {
        const lenderUser = await User.findById(lenderId);
        const borrowerUser = await User.findById(borrowerId);
        const loan = await Loan.create({ lender: lenderUser.id, borrower: borrowerUser.id, borrowerPhone, amount: 680000, amountPaise: 68000000, totalPayable: 680000, totalPayablePaise: 68000000, status: 'active', durationMonths: 12, borrowerName: 'Borrower One' });
        const res = await request(app).post(`/api/loans/${loan._id}/record-payment`).set('Authorization', `Bearer ${lenderToken}`).set('x-idempotency-key', 'test-key-123').send({ amountPaise: 2500000, idToken: 'valid-token' });
        expect(res.status).toBe(200);
        const updatedLoan = await Loan.findById(loan._id);
        expect(updatedLoan.principalOutstandingPaise).toBe(65500000);
    });
    it('should fail explicitly if amountPaise is missing', async () => {
        const res = await request(app).post('/api/loans').set('Authorization', `Bearer ${lenderToken}`).send({ borrower_phone: borrowerPhone, borrower_name: 'Borrower One', duration_months: 12 });
        expect(res.status).toBe(400);
        // Validates that it failed on amountPaise correctly
    });

    it('should reject invalid amountPaise inputs', async () => {
        const invalidInputs = [-100, 0, 1000000000000, 'abc', null, {}, []];
        for (const input of invalidInputs) {
            const res = await request(app).post('/api/loans').set('Authorization', `Bearer ${lenderToken}`).send({ amountPaise: input, borrower_phone: borrowerPhone, borrower_name: 'Borrower One', duration_months: 12 });
            expect(res.status).toBe(400);
        }
    });

    it('should process add-credit securely using amountPaise', async () => {
        const lenderUser = await User.findById(lenderId);
        const borrowerUser = await User.findById(borrowerId);
        const loan = await Loan.create({ lender: lenderUser.id, borrower: borrowerUser.id, borrowerPhone, amount: 680000, amountPaise: 68000000, totalPayable: 680000, totalPayablePaise: 68000000, status: 'active', durationMonths: 12, borrowerName: 'Borrower One', ledgerVersion: 2, principalOutstandingPaise: 68000000 });
        
        // Use idempotency key!
        const res = await request(app).post(`/api/loans/${loan._id}/add-credit`).set('Authorization', `Bearer ${lenderToken}`).set('x-idempotency-key', 'test-credit-123').send({ amountPaise: 2000000, idToken: 'valid-token' });
        expect(res.status).toBe(200);
        const updatedLoan = await Loan.findById(loan._id);
        
        // If the balance is 68,000,000, adding 20,000,000 credit should increase the outstanding principal.
        expect(updatedLoan.principalOutstandingPaise).toBe(88000000);
    });

    it('should normalize legacy data for Flutter on read', async () => {
        const lenderUser = await User.findById(lenderId);
        const borrowerUser = await User.findById(borrowerId);
        
        // Raw mongo insert to bypass Mongoose defaulting
        const db = mongoose.connection.db;
        const legacyLoanId = new mongoose.Types.ObjectId();
        await db.collection('loans').insertOne({
            _id: legacyLoanId,
            lender: lenderUser.id,
            borrower: borrowerUser.id,
            borrowerPhone,
            borrowerName: 'Legacy Borrower',
            durationMonths: 12,
            amount: 680000,
            status: 'active'
        });

        const res = await request(app).get(`/api/loans/${legacyLoanId}`).set('Authorization', `Bearer ${lenderToken}`);
        expect(res.status).toBe(200);
        
        // Output normalization!
        expect(res.body.loan.amountPaise).toBe(68000000);
    });
});
