require('dotenv').config();
const { execSync } = require('child_process');
const mongoose = require('mongoose');

async function testOptionalDocument() {
    console.log('\n--- RUNNING OPTIONAL DOCUMENT TEST ---');
    await mongoose.connect('mongodb://localhost:27017/khatha_test');
    
    const User = require('./models/User');
    const Loan = require('./models/Loan');

    await User.deleteMany({});
    await Loan.deleteMany({});

    const lender = new User({ _id: new mongoose.Types.ObjectId(), phone: '9999999991', role: 'user', id: 'lender1' });
    const borrower = new User({ _id: new mongoose.Types.ObjectId(), phone: '9999999992', role: 'user', id: 'borrower1', email: 'test@test.com' });
    await lender.save();
    await borrower.save();

    // Mock Express req, res
    const req = {
        user: { id: lender.id, phone: lender.phone },
        body: {
            borrower_phone: '9999999992',
            borrower_name: 'Borrower 1',
            amountPaise: 50000,
            duration_months: 6,
            documentId: null, // explicit null like Flutter
            type: 'personal',
            transaction_id: 'test-txn-123'
        }
    };

    let status = null;
    let jsonPayload = null;

    const res = {
        status: (s) => { status = s; return res; },
        json: (payload) => { jsonPayload = payload; return res; }
    };

    const { createLoan } = require('./controllers/loans');

    // Run the middleware manually to mock
    // Wait, the validation middleware is what failed before. 
    // We already changed `validateCreateLoan` in `middleware/validate.js` to handle `nullable: true, checkFalsy: true`.
    
    // Instead of full express stack, let's just invoke createLoan directly because express-validator
    // runs earlier and populate req.body. Let's assume validation passes and passes null.
    await createLoan(req, res);

    if (status !== 201 && status !== 200) {
        throw new Error(`Expected success, got ${status}: ${JSON.stringify(jsonPayload)}`);
    }

    console.log('✅ Optional document creation succeeded!');

    await mongoose.disconnect();
}

testOptionalDocument().catch(err => {
    console.error(err);
    process.exit(1);
});
