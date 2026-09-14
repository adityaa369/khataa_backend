require('dotenv').config();
const mongoose = require('mongoose');
const { execSync } = require('child_process');

async function runContractTests() {
    console.log('\n--- RUNNING LOAN RESPONSE CONTRACT TESTS ---');
    await mongoose.connect('mongodb://localhost:27017/khatha_test');
    
    const User = require('./models/User');
    const Loan = require('./models/Loan');
    const { serializeLoan } = require('./utils/loanSerializer');

    await User.deleteMany({});
    await Loan.deleteMany({});

    const lender = new User({ _id: new mongoose.Types.ObjectId(), phone: '9999999991', role: 'user', id: 'lender1' });
    const borrower = new User({ _id: new mongoose.Types.ObjectId(), phone: '9999999992', role: 'user', id: 'borrower1' });
    await lender.save();
    await borrower.save();

    const legacyLoanId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('loans').insertOne({
        _id: legacyLoanId,
        lender: lender.id,
        borrower: borrower.id,
        borrowerName: 'Borrower B1',
        borrowerPhone: '9999999992',
        amount: 500, // Legacy format (Rupees)
        status: 'active'
    });

    const v2LoanId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('loans').insertOne({
        _id: v2LoanId,
        lender: lender.id,
        borrower: borrower.id,
        borrowerName: 'Borrower B1',
        borrowerPhone: '9999999992',
        amountPaise: 80000, // V2 format
        principalOutstandingPaise: 80000,
        status: 'active'
    });

    // Test serialization
    const legacyDoc = await Loan.findById(legacyLoanId);
    const legacySerialized = serializeLoan(legacyDoc);
    
    if (legacySerialized.amountPaise !== 50000) {
        throw new Error('Legacy loan did not correctly project amountPaise');
    }
    console.log('✅ Legacy loan successfully projected amountPaise');

    const v2Doc = await Loan.findById(v2LoanId);
    const v2Serialized = serializeLoan(v2Doc);
    if (v2Serialized.amountPaise !== 80000) {
        throw new Error('V2 loan altered valid amountPaise');
    }
    console.log('✅ V2 loan preserved valid amountPaise');

    await mongoose.disconnect();
    console.log('--- CONTRACT TESTS PASSED ---');
}

runContractTests().catch(err => {
    console.error(err);
    process.exit(1);
});
