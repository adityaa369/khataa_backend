const mongoose = require('mongoose');
const assert = require('assert');
const Loan = require('./models/Loan');
const FinancialLedgerService = require('./services/FinancialLedgerService');
const { parseRupeesToPaise, formatPaiseToString } = require('./utils/money');
require('dotenv').config({ path: './.env' });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret';

async function runTests() {
    let successCount = 0;
    let failCount = 0;
    
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    const replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replset.getUri());

    const app = require('./index');
    const request = require('supertest');

    const test = async (name, fn) => {
        try {
            await fn();
            console.log('✅ PASSED: ' + name);
            successCount++;
        } catch (e) {
            console.error('❌ FAILED: ' + name);
            console.error(e.stack);
            failCount++;
        }
    };

    console.log('\n--- 4H-B2: Testing Money String Parsing ---');
    await test('Parses simple rupee amount', async () => {
        assert.strictEqual(parseRupeesToPaise('100'), 10000);
        assert.strictEqual(parseRupeesToPaise('100.50'), 10050);
        assert.strictEqual(parseRupeesToPaise('100.05'), 10005);
        assert.strictEqual(parseRupeesToPaise('0.99'), 99);
    });

    await test('Parses invalid decimal input to safe 0', async () => {
        assert.strictEqual(parseRupeesToPaise('NaN'), 0);
        assert.strictEqual(parseRupeesToPaise('Infinity'), 0);
        assert.strictEqual(parseRupeesToPaise('100.50.20'), 0);
        assert.strictEqual(parseRupeesToPaise('1e5'), 0);
    });

    await test('Parses negative amount safely', async () => {
        assert.strictEqual(parseRupeesToPaise('-50.25'), -5025);
    });

    await test('Formats paise to string safely', async () => {
        assert.strictEqual(formatPaiseToString(10050), '100.50');
        assert.strictEqual(formatPaiseToString(5), '0.05');
        assert.strictEqual(formatPaiseToString(-1025), '-10.25');
        assert.strictEqual(formatPaiseToString(NaN), '0.00');
    });

    console.log('\n--- 4H-B2: Testing Strict Integer Contract Validation ---');
    const User = require('./models/User'); await User.create({ id: 'L1', firstName: 'L', lastName: '1', phone: '+919999999999' }); const mockLoan = await Loan.create({
        borrower: 'B1', lender: 'L1', durationMonths: 1, amountPaise: 100, loanType: 'INTEREST_CREDIT', status: 'active',
        amount: 1, borrowerPhone: '1234567890', borrowerName: 'Test'
    });

    const jwt = require('jsonwebtoken'); const token = jwt.sign({ id: 'L1', phone: '123', role: 'USER' }, process.env.JWT_SECRET);
    const checkInput = async (input, expectStatus) => {
        const res = await request(app).post(`/api/loans/${mockLoan._id}/add-credit`).set('Authorization', 'Bearer ' + token).send({ amountPaise: input, intentId: 'dummy', idToken: 'dummy' });
        if(expectStatus === 400) {
             assert.strictEqual(res.status, 400, 'Expected 400 for input: ' + JSON.stringify(input) + ' but got ' + res.status);
        }
    };

    await test('Rejects decimal string "100.99"', async () => await checkInput('100.99', 400));
    await test('Rejects decimal float 100.99', async () => await checkInput(100.99, 400));
    await test('Rejects trailing chars "100abc"', async () => await checkInput('100abc', 400));
    await test('Rejects scientific notation "1e3"', async () => await checkInput('1e3', 400));
    await test('Rejects padded string " 100 "', async () => await checkInput(' 100 ', 400));
    await test('Rejects null', async () => await checkInput(null, 400));
    await test('Rejects {}', async () => await checkInput({}, 400));
    await test('Rejects []', async () => await checkInput([], 400));

    console.log('\n--- 4H-B2: Testing CPP Remainder Distribution ---');
    await test('₹1 over 3 months -> remainder handled correctly', async () => {
        const loan = new Loan({
            borrower: 'B1', lender: 'L1', durationMonths: 3, amountPaise: 100, loanType: 'INTEREST_CREDIT', status: 'pending_approval', amount: 1, borrowerPhone: '1234567890', borrowerName: 'Test'
        });
        await loan.save();
        
        const TransactionIntent = require('./models/TransactionIntent');
        await TransactionIntent.create({ intentId: 'dummy-intent', loanId: loan._id, status: 'PENDING', expiresAt: new Date(Date.now()+10000), action: 'ACCEPT_LOAN', userId: 'B1' });

        await FinancialLedgerService.acceptLoan(loan._id, 'B1', 'dummy-intent');
        const accepted = await Loan.findById(loan._id);
        
        assert.strictEqual(accepted.agreementSnapshot.constantPrincipalPortionPaise, 33);
        assert.strictEqual(accepted.agreementSnapshot.cppRemainderPaise, 1);
    });

    await test('large principal / N', async () => {
        const loan = new Loan({
            borrower: 'B1', lender: 'L1', durationMonths: 7, amountPaise: 10000000, loanType: 'INTEREST_CREDIT', status: 'pending_approval', amount: 100000, borrowerPhone: '1234567890', borrowerName: 'Test'
        });
        await loan.save();
        const TransactionIntent = require('./models/TransactionIntent');
        await TransactionIntent.create({ intentId: 'dummy-intent-2', loanId: loan._id, status: 'PENDING', expiresAt: new Date(Date.now()+10000), action: 'ACCEPT_LOAN', userId: 'B1' });

        await FinancialLedgerService.acceptLoan(loan._id, 'B1', 'dummy-intent-2');
        const accepted = await Loan.findById(loan._id);
        const base = Math.floor(10000000 / 7);
        const rem = 10000000 % 7;
        assert.strictEqual(accepted.agreementSnapshot.constantPrincipalPortionPaise, base);
        assert.strictEqual(accepted.agreementSnapshot.cppRemainderPaise, rem);
        assert.strictEqual((base * 7) + rem, 10000000);
    });

    await test('remainder = 0', async () => {
        const loan = new Loan({
            borrower: 'B1', lender: 'L1', durationMonths: 5, amountPaise: 10000, loanType: 'INTEREST_CREDIT', status: 'pending_approval', amount: 100, borrowerPhone: '1234567890', borrowerName: 'Test'
        });
        await loan.save();
        const TransactionIntent = require('./models/TransactionIntent');
        await TransactionIntent.create({ intentId: 'dummy-intent-3', loanId: loan._id, status: 'PENDING', expiresAt: new Date(Date.now()+10000), action: 'ACCEPT_LOAN', userId: 'B1' });

        await FinancialLedgerService.acceptLoan(loan._id, 'B1', 'dummy-intent-3');
        const accepted = await Loan.findById(loan._id);
        assert.strictEqual(accepted.agreementSnapshot.constantPrincipalPortionPaise, 2000);
        assert.strictEqual(accepted.agreementSnapshot.cppRemainderPaise, 0);
    });
    
    console.log('\n4H-B2 TESTS FINISHED: ' + successCount + ' Passed, ' + failCount + ' Failed');
    process.exit(failCount > 0 ? 1 : 0);
}

runTests();
