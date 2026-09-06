const mongoose = require('mongoose');
const assert = require('assert');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const fs = require('fs');
const request = require('supertest');
const jwt = require('jsonwebtoken');
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret';

let replSet;
let app;
let Loan, User, TransactionIntent;
let lenderId, borrowerId, unrelatedId;
let lenderToken, borrowerToken, unrelatedToken;
let lender, borrower, unrelated;

async function setup() {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    
    const rl = require('./middleware/rateLimiter');
    rl.apiLimiter = (req, res, next) => next();
    rl.authLimiter = (req, res, next) => next();
    rl.financialLimiter = (req, res, next) => next();
    
    app = require('./index');
    
    Loan = require('./models/Loan');
    User = require('./models/User');
    TransactionIntent = require('./models/TransactionIntent');
    
    lender = await User.create({ id: 'L', firstName: 'L', lastName: 'L', phone: '+919999999991' });
    borrower = await User.create({ id: 'B', firstName: 'B', lastName: 'B', phone: '+919999999992' });
    unrelated = await User.create({ id: 'U', firstName: 'U', lastName: 'U', phone: '+919999999993' });
    
    lenderId = lender._id.toString();
    borrowerId = borrower._id.toString();
    unrelatedId = unrelated._id.toString();

    const generateToken = (userId, phone) => {
        return jwt.sign({ id: userId, phone, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    };

    lenderToken = generateToken(lender.id, lender.phone);
    borrowerToken = generateToken(borrower.id, borrower.phone);
    unrelatedToken = generateToken(unrelated.id, unrelated.phone);
}

async function runTests() {
    await setup();
    let passed = 0, total = 0;

    function assertThrows(condition, message) {
        total++;
        if (!condition) {
            console.error("❌ FAILED: " + message);
            process.exit(1);
        }
        console.log("✅ PASSED: " + message);
        passed++;
    }

    try {
        console.log('\\n--- 4H-B1: Verifying Absence of Legacy V1 Writes ---');
        const loansJs = fs.readFileSync('controllers/loans.js', 'utf8');
        assertThrows(!loansJs.includes('_handleCustomTransaction'), 'Legacy _handleCustomTransaction must be removed');
        assertThrows(!fs.existsSync('original_loans.js'), 'original_loans.js must be deleted');

        console.log('\\n--- 4H-B1: Testing verifyLoan Security Rules ---');
        
        let loan = await Loan.create({
            lender: lender.id, borrower: borrower.id, 
            borrowerPhone: '+919999999992', borrowerName: 'B',
            amount: 1000, amountPaise: 100000, interestRate: 1.5, durationMonths: 1,
            agreementSnapshot: {
                initialPrincipalPaise: 100000,
                expectedPrincipalPaise: 100000,
                interestMethod: 'NONE',
                interestRateBps: 0,
                durationMonths: 1
            },
            status: 'pending_approval'
        });

        let res = await request(app).post('/api/loans/' + loan._id + '/verify').set('Authorization', 'Bearer ' + borrowerToken).send({});
        assertThrows(res.status === 400 && res.body.message.includes('OTP and intentId are required'), 'Rejects missing OTP/intent');

        res = await request(app).post('/api/loans/' + loan._id + '/verify').set('Authorization', 'Bearer ' + borrowerToken).send({ otp: 'INVALID', intentId: 'dummy' });
        assertThrows(res.status === 400 && res.body.message.includes('Invalid OTP'), 'Rejects invalid OTP');

        const loansController = require('./controllers/loans');
        loansController._verifyFirebaseIdToken = async (token) => {
            if (token === 'VALID_OTP_B') return { success: true, uid: 'uid1', phone: '+919999999992' };
            if (token === 'VALID_OTP_U') return { success: true, uid: 'uid2', phone: '+919999999993' };
            return { success: false, error: 'invalid token' };
        };

        res = await request(app).post('/api/loans/' + loan._id + '/verify').set('Authorization', 'Bearer ' + borrowerToken).send({ otp: 'VALID_OTP_U', intentId: 'dummy' });
        assertThrows(res.status === 400 && res.body.message.includes('OTP phone mismatch'), 'Rejects OTP if phone mismatch');

        let intent = await TransactionIntent.create({
            loanId: loan._id, userId: 'B', action: 'ACCEPT_LOAN', expiresAt: new Date(Date.now() + 100000)
        });
        
        await TransactionIntent.updateOne({ _id: intent._id }, { status: 'CONSUMED' });
        res = await request(app).post('/api/loans/' + loan._id + '/verify').set('Authorization', 'Bearer ' + borrowerToken).send({ otp: 'VALID_OTP_B', intentId: intent.intentId });
        assertThrows(res.status !== 200, 'Rejects consumed intent');
        
        await TransactionIntent.updateOne({ _id: intent._id }, { status: 'PENDING' });

        res = await request(app).post('/api/loans/' + loan._id + '/verify').set('Authorization', 'Bearer ' + borrowerToken).send({ otp: 'VALID_OTP_B', intentId: intent.intentId });
        assertThrows(res.status === 200, 'Successful loan acceptance with valid OTP and Intent');
        
        res = await request(app).post('/api/loans/' + loan._id + '/verify').set('Authorization', 'Bearer ' + borrowerToken).send({ otp: 'VALID_OTP_B', intentId: intent.intentId });
        assertThrows(res.status !== 200, 'Rejects replay of same intent');

        console.log('\n--- 4H-B1: Testing addCredit Security Rules ---');
        
        res = await request(app).post('/api/loans/' + loan._id + '/add-credit').set('Authorization', 'Bearer ' + lenderToken).send({ amountPaise: 50000 });
        assertThrows(res.status === 400 && res.body.message.includes('Intent ID and OTP required'), 'addCredit rejects missing OTP/intent');

        let creditIntent = await TransactionIntent.create({
            loanId: loan._id, userId: 'L', action: 'ADD_CREDIT', payload: { amountPaise: 50000 }, expiresAt: new Date(Date.now() + 100000)
        });

        res = await request(app).post('/api/loans/' + loan._id + '/add-credit').set('Authorization', 'Bearer ' + lenderToken).send({ amountPaise: 50000, idToken: 'VALID_OTP_B', intentId: creditIntent.intentId });
        if (res.status !== 200) console.log('addCredit failure body:', JSON.stringify(res.body));
        assertThrows(res.status === 200, 'Successful addCredit with valid OTP and Intent');

        const updatedLoan = await Loan.findById(loan._id);
        assertThrows(updatedLoan.principalOutstandingPaise === 150000, 'Ledger accurately materialized addCredit amount');

        console.log('4H-B1 AUDIT TESTS PASSED: ' + passed + '/' + total);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
runTests();
