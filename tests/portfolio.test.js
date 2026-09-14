const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../server');
const User = require('../models/User');
const Loan = require('../models/Loan');

describe('Portfolio Summary API Security & Aggregation Tests (F.4.1)', () => {
    let tokenA, tokenB;
    let userA, userB;

    beforeAll(async () => {
        // Clear DB
        await User.deleteMany();
        await Loan.deleteMany();

        // Create Users
        userA = await User.create({
            firstName: 'Lender', lastName: 'A', phone: '+919999999991',
            password: 'Password123'
        });
        userB = await User.create({
            firstName: 'Lender', lastName: 'B', phone: '+919999999992',
            password: 'Password123'
        });

        // Get Tokens
        const resA = await request(app).post('/api/auth/login').send({ phone: '+919999999991', password: 'Password123' });
        tokenA = resA.body.token;

        const resB = await request(app).post('/api/auth/login').send({ phone: '+919999999992', password: 'Password123' });
        tokenB = resB.body.token;

        // Create Loans for Lender A (One active, one pending, one closed, one legacy)
        await Loan.insertMany([
            {
                lender: userA._id, borrowerName: 'B1', borrowerPhone: '+918888888881',
                amountPaise: 50000, totalPayablePaise: 60000, paidAmountPaise: 20000,
                status: 'active', type: 'personal'
            },
            {
                lender: userA._id, borrowerName: 'B2', borrowerPhone: '+918888888882',
                amount: 1000, // Legacy float = 100,000 paise
                totalPayable: 1100, // Legacy float = 110,000 paise
                paidAmount: 500, // Legacy float = 50,000 paise
                status: 'due_soon', type: 'business'
            },
            {
                lender: userA._id, borrowerName: 'B3', borrowerPhone: '+918888888883',
                amountPaise: 20000, totalPayablePaise: 25000, paidAmountPaise: 0,
                status: 'pending_approval', type: 'personal'
            }
        ]);

        // Create Loans for Lender B
        await Loan.create({
            lender: userB._id, borrowerName: 'B4', borrowerPhone: '+918888888884',
            amountPaise: 500000, totalPayablePaise: 600000, paidAmountPaise: 0,
            status: 'active', type: 'personal'
        });
    });

    afterAll(async () => {
        await mongoose.connection.close();
    });

    test('Lender A sees only Lender A data & correctly computes paise (including legacy floats)', async () => {
        const res = await request(app)
            .get('/api/loans/portfolio-summary')
            .set('Authorization', Bearer  + tokenA);
            
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.loanCount).toBe(3); // Total
        expect(res.body.data.activeLoanCount).toBe(2); // Only active/due_soon
        
        // Lent: 50000 (paise) + 100000 (legacy converted) = 150000. Pending is excluded.
        expect(res.body.data.totalLentPaise).toBe(150000);
        
        // Collected: 20000 + 50000 = 70000
        expect(res.body.data.totalCollectedPaise).toBe(70000);
        
        // Outstanding: (60000 - 20000) + (110000 - 50000) = 40000 + 60000 = 100000
        expect(res.body.data.outstandingPaise).toBe(100000);
    });

    test('Lender B cannot see Lender A data (Ownership isolation)', async () => {
        const res = await request(app)
            .get('/api/loans/portfolio-summary')
            .set('Authorization', Bearer  + tokenB);
            
        expect(res.status).toBe(200);
        expect(res.body.data.loanCount).toBe(1);
        expect(res.body.data.totalLentPaise).toBe(500000);
    });

    test('Unauthenticated returns 401', async () => {
        const res = await request(app).get('/api/loans/portfolio-summary');
        expect(res.status).toBe(401);
    });
});
