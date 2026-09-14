const mongoose = require('mongoose');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');

// Setup env
dotenv.config();

// We will require the app after env is loaded
const app = require('../../index'); // this starts the server and connects to Mongo/Redis, maybe?
// Wait, index.js usually starts listening. We might just use it or bypass `app.listen`.
// Assuming index.js exports the express app but also calls `app.listen`, which is fine for tests if we just use the app object.
// Let's create a standalone runner.

const User = require('../../models/User');
const Loan = require('../../models/Loan');
const { cacheInvalidate } = require('../../config/redis');

async function setupTestData() {
    // create a test user
    const randId = Date.now() + Math.floor(Math.random() * 1000);
    const lender = new User({
        id: 'lender_p04_' + randId,
        phone: '99' + randId.toString().substring(0, 8),
        firstName: 'Test',
        lastName: 'Lender'
    });
    await lender.save();

    const borrower = new User({
        id: 'borrower_p04_' + randId,
        phone: '88' + randId.toString().substring(0, 8),
        firstName: 'Test',
        lastName: 'Borrower'
    });
    await borrower.save();

    // seed legacy V1 loan (no paise fields)
    const loan = new Loan({
        lender: lender.id,
        borrower: borrower.id,
        borrowerName: borrower.firstName,
        borrowerPhone: borrower.phone,
        amount: 5000,
        totalPayable: 5000,
        paidAmount: 0,
        durationMonths: 12,
        status: 'active'
    });
    await loan.save();

    // generate token
    const token = jwt.sign({ id: lender.id, phone: lender.phone }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });

    return { lender, borrower, loan, token };
}

async function runTests() {
    let totals = { PASS: 0, FAIL: 0, SKIP: 0, ERROR: 0, TOTAL_ASSERTIONS: 0, TESTS_EXECUTED: 0 };
    
    console.log('Connecting to MongoDB...');
    // Ensure connection is established if index.js didn't already
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/khata');
    }

    console.log('Setting up test data...');
    const data = await setupTestData();
    console.log('Waiting for Express to start...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('Running P0-4 HTTP Contract Test...');
    try {
        const p04 = require('./p04_loan_serialization.test.js');
        const result = await p04.run(app, data.token, data.lender.id);
        totals.PASS++;
        totals.TOTAL_ASSERTIONS += result.assertions;
        totals.TESTS_EXECUTED++;
        console.log('✅ P0-4 Passed');
    } catch (err) {
        totals.FAIL++;
        totals.TESTS_EXECUTED++;
        console.error('❌ P0-4 Failed:', err.message);
        console.error(err.stack);
    }

    console.log('\n--- TEST RESULTS ---');
    console.log(`TESTS_EXECUTED:   ${totals.TESTS_EXECUTED}`);
    console.log(`PASS:             ${totals.PASS}`);
    console.log(`FAIL:             ${totals.FAIL}`);
    console.log(`SKIP:             ${totals.SKIP}`);
    console.log(`ERROR:            ${totals.ERROR}`);
    console.log(`TOTAL_ASSERTIONS: ${totals.TOTAL_ASSERTIONS}`);
    console.log('--------------------\n');

    if (totals.TESTS_EXECUTED === 0 || totals.FAIL > 0 || totals.SKIP > 0 || totals.ERROR > 0 || totals.TOTAL_ASSERTIONS === 0) {
        console.error('Gate Failure.');
        process.exit(1);
    }

    console.log('Gate Passed.');
    process.exit(0);
}

runTests().catch(err => {
    console.error('Test Runner Error:', err);
    process.exit(1);
});
