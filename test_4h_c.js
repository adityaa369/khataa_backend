/**
 * Phase 4H-C — Release Candidate Certification Suite
 * End-to-end flow certification testing
 */
'use strict';

const request = require('supertest');
const assert = require('assert');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_key_v2';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';

let replSet;
let app;
let passed = 0;
let total = 0;

// Test variables
let lenderToken, borrowerToken, lenderUser, borrowerUser;
let handLoanId, businessLoanId, interestLoanId;

// Helpers
function assertPass(condition, msg) {
    total++;
    if (!condition) throw new Error(`Assertion failed: ${msg}`);
    passed++;
    console.log(`✅ PASSED: ${msg}`);
}

async function getNextIntentId() {
    return 'intent-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
}

async function testFlow() {
    try {
        console.log('\n=== 4H-C: RC END-TO-END CERTIFICATION ===\n');

        // Setup
        replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
        await mongoose.connect(replSet.getUri());

        const rl = require('./middleware/rateLimiter');
        rl.apiLimiter = (req, res, next) => next();
        rl.financialLimiter = (req, res, next) => next();
        const { fireAlert } = require('./utils/AlertManager');

        app = require('./index');
        await new Promise(r => setTimeout(r, 500));

        const User = require('./models/User');
const Transaction = require('./models/Transaction');
        lenderUser = await User.create({ phone: '9999999991', name: 'Lender L1', isVerified: true, id: 'L1', email: 'lender@test.com' });
        borrowerUser = await User.create({ phone: '9999999992', name: 'Borrower B1', isVerified: true, id: 'B1', email: 'borrower@test.com' });
        
        lenderToken = jwt.sign({ id: 'L1', userId: lenderUser._id }, process.env.JWT_SECRET);
        borrowerToken = jwt.sign({ id: 'B1', userId: borrowerUser._id }, process.env.JWT_SECRET);

        // Allow dummy OTP
        const loansController = require('./controllers/loans');
        loansController._verifyFirebaseIdToken = async (token) => {
            if (token === 'DUMMY_B1') return { success: true, uid: 'uid_b1', phone: '+919999999992' };
            return { success: false };
        };

        const TransactionIntent = require('./models/TransactionIntent');
        const Loan = require('./models/Loan');

        console.log('\n--- SCENARIO 1: HAND LOAN ---');
        
        // 1. Create HAND loan
        let res = await request(app).post('/api/loans').set('Authorization', 'Bearer ' + lenderToken).set('x-idempotency-key', 'cert-create-1').send({
            borrower_phone: '9999999992',
            borrower_name: 'Borrower B1',
            amountPaise: 500000, // ₹5000
            interest_rate: 0,
            duration_months: 1,
            type: 'personal' // hand
        });
        if (res.status !== 201) { console.log('HAND CREATE FAILED', JSON.stringify(res.body)); } assertPass(res.status === 201, 'HAND Create: 201 Created');
        handLoanId = res.body.loan._id;
        assertPass(res.body.loan.status === 'pending_approval', 'HAND: Initial status pending_approval');
        

        // 2. Verify HAND loan (Borrower OTP)
        let intentId = await getNextIntentId();
        await TransactionIntent.create({ loanId: handLoanId, userId: borrowerUser._id, action: 'ACCEPT_LOAN', payload: {}, expiresAt: new Date(Date.now() + 60000), intentId });
        
        res = await request(app).post(`/api/loans/${handLoanId}/verify`)
            .set('Authorization', 'Bearer ' + borrowerToken)
            .set('x-idempotency-key', 'cert-hand-verify')
            .send({ otp: 'DUMMY_B1', intentId });
        assertPass(res.status === 200, 'HAND Verify: 200 OK');
        
        let loanDoc = await Loan.findById(handLoanId);
        assertPass(loanDoc.status === 'active', 'HAND: Status becomes active');
        assertPass(loanDoc.principalOutstandingPaise === 500000, 'HAND: Principal outstanding is 500000');
        
        let ledger = await Transaction.find({ loanId: handLoanId });
        assertPass(ledger.length === 1 && ledger[0].type === 'LOAN_CREATED' && ledger[0].principalDeltaPaise === 500000, 'HAND: Exact 1 initial ledger entry');

        // 3. Payment HAND loan
        intentId = await getNextIntentId();
        await TransactionIntent.create({ loanId: handLoanId, userId: lenderUser._id, action: 'RECORD_PAYMENT', payload: { paymentAmountPaise: 200000 }, expiresAt: new Date(Date.now() + 60000), intentId });
        
        res = await request(app).post(`/api/loans/${handLoanId}/record-payment`).set('Authorization', 'Bearer ' + lenderToken)
            .set('x-idempotency-key', 'cert-hand-pay1')
            .send({ amountPaise: 200000, idToken: 'DUMMY_B1', intentId });
        assertPass(res.status === 200, 'HAND Payment: 200 OK');
        
        loanDoc = await Loan.findById(handLoanId);
        assertPass(loanDoc.principalOutstandingPaise === 300000, 'HAND: Principal drops to 300000 after ₹2000 payment');

        // 4. Idempotency test (Retry payment)
        res = await request(app).post(`/api/loans/${handLoanId}/record-payment`).set('Authorization', 'Bearer ' + lenderToken)
            .set('x-idempotency-key', 'cert-hand-pay1') // Same idempotency key
            .send({ amountPaise: 200000, idToken: 'DUMMY_B1', intentId });
        assertPass(res.status === 200, 'HAND Retry Payment: 200 OK (Idempotent replay)');
        
        loanDoc = await Loan.findById(handLoanId);
        assertPass(loanDoc.principalOutstandingPaise === 300000, 'HAND: Principal unchanged after idempotent retry');
        ledger = await Transaction.find({ loanId: handLoanId, type: 'PAYMENT' });
        assertPass(ledger.length === 1, 'HAND: No duplicate ledger entry on retry');

        // 5. Add Credit HAND loan
        intentId = await getNextIntentId();
        await TransactionIntent.create({ loanId: handLoanId, userId: lenderUser._id, action: 'ADD_CREDIT', payload: { amountPaise: 100000 }, expiresAt: new Date(Date.now() + 60000), intentId });
        
        res = await request(app).post(`/api/loans/${handLoanId}/add-credit`)
            .set('Authorization', 'Bearer ' + lenderToken)
            .set('x-idempotency-key', 'cert-hand-add1')
            .send({ amountPaise: 100000, idToken: 'DUMMY_B1', intentId });
        assertPass(res.status === 200, 'HAND Add Credit: 200 OK');
        
        loanDoc = await Loan.findById(handLoanId);
        assertPass(loanDoc.principalOutstandingPaise === 400000, 'HAND: Principal increases to 400000');

        // 6. Close Loan
        res = await request(app).post(`/api/loans/${handLoanId}/close`)
            .set('Authorization', 'Bearer ' + lenderToken)
            .set('x-idempotency-key', 'cert-hand-close').send({ idToken: 'DUMMY_B1' });
        assertPass(res.status === 200, 'HAND Close: 200 OK');
        
        loanDoc = await Loan.findById(handLoanId);
        assertPass(loanDoc.status === 'closed', 'HAND: Status becomes closed');
        
        // 7. Terminal State Protection
        intentId = await getNextIntentId();
        await TransactionIntent.create({ loanId: handLoanId, userId: lenderUser._id, action: 'RECORD_PAYMENT', payload: { paymentAmountPaise: 100000 }, expiresAt: new Date(Date.now() + 60000), intentId });
        res = await request(app).post(`/api/loans/${handLoanId}/record-payment`).set('Authorization', 'Bearer ' + lenderToken)
            .set('x-idempotency-key', 'cert-hand-pay2')
            .send({ amountPaise: 100000, idToken: 'DUMMY_B1', intentId });
        assertPass(res.status === 400, 'HAND Terminal: Rejects payment on closed loan');


        console.log('\n--- SCENARIO 2: BUSINESS LOAN ---');
        
        res = await request(app).post('/api/loans').set('Authorization', 'Bearer ' + lenderToken).set('x-idempotency-key', 'cert-create-2').send({
            borrower_phone: '9999999992', borrower_name: 'Borrower B1', amountPaise: 1000000, interest_rate: 0, duration_months: 3, type: 'business'
        });
        assertPass(res.status === 201, 'BUSINESS Create: 201 Created');
        businessLoanId = res.body.loan._id;
        assertPass(res.body.loan.loanType === 'business', 'BUSINESS: Type preserved');

        intentId = await getNextIntentId();
        await TransactionIntent.create({ loanId: businessLoanId, userId: borrowerUser._id, action: 'ACCEPT_LOAN', payload: {}, expiresAt: new Date(Date.now() + 60000), intentId });
        await request(app).post(`/api/loans/${businessLoanId}/verify`).set('Authorization', 'Bearer ' + borrowerToken).set('x-idempotency-key', 'cert-bus-ver').send({ otp: 'DUMMY_B1', intentId });
        
        loanDoc = await Loan.findById(businessLoanId);
        assertPass(loanDoc.status === 'active' && loanDoc.principalOutstandingPaise === 1000000, 'BUSINESS: Active and principal correct');


        console.log('\n--- SCENARIO 3: INTEREST LOAN ---');
        
        res = await request(app).post('/api/loans').set('Authorization', 'Bearer ' + lenderToken).set('x-idempotency-key', 'cert-create-3').send({
            borrower_phone: '9999999992', borrower_name: 'Borrower B1', amountPaise: 1200000, interest_rate: 10, duration_months: 12, type: 'interest_credit' // Reducing balance
        });
        assertPass(res.status === 201, 'INTEREST Create: 201 Created');
        interestLoanId = res.body.loan._id;
        assertPass(res.body.loan.interestRate === 10, 'INTEREST: Rate 10%');

        intentId = await getNextIntentId();
        await TransactionIntent.create({ loanId: interestLoanId, userId: borrowerUser._id, action: 'ACCEPT_LOAN', payload: {}, expiresAt: new Date(Date.now() + 60000), intentId });
        let resV = await request(app).post(`/api/loans/${interestLoanId}/verify`).set('Authorization', 'Bearer ' + borrowerToken).set('x-idempotency-key', 'cert-int-ver').send({ otp: 'DUMMY_B1', intentId });
        if (resV.status !== 200) console.log('INTEREST VERIFY FAILED', JSON.stringify(resV.body));
        assertPass(resV.status === 200, 'INTEREST Verify: 200 OK');
        
        loanDoc = await Loan.findById(interestLoanId);
        if (loanDoc.agreementSnapshot.interestMethod !== 'REDUCING_BALANCE') console.log('METHOD IS:', loanDoc.agreementSnapshot.interestMethod);
        assertPass(loanDoc.agreementSnapshot.interestMethod === 'REDUCING_BALANCE', 'INTEREST: Method is REDUCING_BALANCE');
        assertPass(loanDoc.agreementSnapshot.constantPrincipalPortionPaise === 100000, 'INTEREST: CPP is exactly 100000 per month (1200000/12)');

        // Simulate 1 month of interest
        const FinancialLedgerService = require('./services/FinancialLedgerService');
        await FinancialLedgerService.accrueInterest(interestLoanId, 'cert-accrual-m1', new Date(Date.now() - 86400000*30), new Date());
        
        loanDoc = await Loan.findById(interestLoanId);
        assertPass(loanDoc.interestOutstandingPaise > 0, `INTEREST: Accrual produced interest: ${loanDoc.interestOutstandingPaise} paise`);
        
        // Underpayment
        const initialInt = loanDoc.interestOutstandingPaise;
        intentId = await getNextIntentId();
        await TransactionIntent.create({ loanId: interestLoanId, userId: lenderUser._id, action: 'RECORD_PAYMENT', payload: { paymentAmountPaise: 5000 }, expiresAt: new Date(Date.now() + 60000), intentId });
        await request(app).post(`/api/loans/${interestLoanId}/record-payment`).set('Authorization', 'Bearer ' + lenderToken).set('x-idempotency-key', 'cert-int-pay1').send({ amountPaise: 5000, idToken: 'DUMMY_B1', intentId });
        
        loanDoc = await Loan.findById(interestLoanId);
        assertPass(loanDoc.interestOutstandingPaise === initialInt - 5000, 'INTEREST: Underpayment clears interest first exactly');
        assertPass(loanDoc.principalOutstandingPaise === 1200000, 'INTEREST: Principal untouched by underpayment');


        console.log('\n--- SCENARIO 4: CROSS-CUTTING CONCERNS ---');

        // Auth Expiry / Missing
        res = await request(app).get(`/api/loans/${handLoanId}`);
        assertPass(res.status === 401, 'CROSS: Missing token → 401');

        // Account Isolation
        const hackerUser = await User.create({ id: 'HACKER_UID', email: 'hacker@example.com', phone: '9999999993', name: 'Hacker', isVerified: true });
        process.env.JWT_SECRET = 'test_secret_key';
        const hackerToken = jwt.sign({ id: hackerUser.id, userId: hackerUser.id }, process.env.JWT_SECRET);
        res = await request(app).get(`/api/loans/${handLoanId}`).set('Authorization', 'Bearer ' + hackerToken);
        if (res.status !== 403 && res.status !== 404) console.log('HACKER STATUS:', res.status, res.body);
        assertPass(res.status === 403 || res.status === 404, 'CROSS: Wrong user access denied');

        // Document Authorization
        res = await request(app).get('/api/documents/some-doc-id').set('Authorization', 'Bearer ' + hackerToken);
        // Returns 404 if doc not found, but it MUST NOT return 401 if token is valid
        assertPass(res.status !== 401, 'CROSS: Valid token accepted for documents');

        console.log('\n--- SCENARIO 5: FINANCIAL INVARIANTS ---');

        // No Legacy Writes
        const fs = require('fs');
        const loanCtrlSrc = fs.readFileSync('controllers/loans.js', 'utf8');
        assertPass(!loanCtrlSrc.includes('_handleCustomTransaction'), 'INVARIANT: Legacy _handleCustomTransaction is completely removed from source');
        assertPass(!fs.existsSync('original_loans.js'), 'INVARIANT: original_loans.js is permanently deleted');

        // Exact-Once Materialization & Summing
        const allLedgers = await Transaction.find({ loanId: handLoanId });
        let netPrincipal = 0;
        for (const l of allLedgers) {
            netPrincipal += (l.principalDeltaPaise || 0);
        }
        loanDoc = await Loan.findById(handLoanId);
        assertPass(netPrincipal === 0 && loanDoc.principalOutstandingPaise === 0, 'INVARIANT: sum(all principal effects) exactly matches materialization (0 for closed loan)');

        // Reconciliation Check
        const ReconciliationService = require('./services/ReconciliationService');
        await ReconciliationService.reconcileLoans();
        const AlertRecord = require('./models/AlertRecord');
        const alerts = await AlertRecord.find({ entityId: handLoanId });
        const isHealthy = alerts.length === 0;
        assertPass(isHealthy === true, 'INVARIANT: V2 Ledger perfectly reconciled with Loan cache');

        console.log(`\n=== 4H-C END-TO-END CERTIFICATION FINISHED: ${passed}/${total} Passed ===`);
        process.exit(0);

    } catch (err) {
        console.error('Fatal certification error:', err.stack);
        process.exit(1);
    }
}

testFlow();
