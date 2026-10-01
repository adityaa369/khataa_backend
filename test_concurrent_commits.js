require('dotenv').config();
const mongoose = require('mongoose');
const { initiatePayment, commitPayment } = require('./controllers/payments');
const Loan = require('./models/Loan');
const TransactionIntent = require('./models/TransactionIntent');
const OtpChallenge = require('./models/OtpChallenge');
const User = require('./models/User');

async function testConcurrency() {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/khatha_test');
    
    // Clear collections for test
    await Loan.deleteMany({});
    await TransactionIntent.deleteMany({});
    await OtpChallenge.deleteMany({});
    
    const lender = new User({ phone: '+1000000001', name: 'Lender', id: 'l1' });
    const borrower = new User({ phone: '+2000000001', name: 'Borrower', id: 'b1' });

    const loan = new Loan({
        lender: lender._id,
        borrower: borrower._id,
        amount: 3000,
        amountPaise: 300000,
        transactions: [{ type: 'loan_given', amountPaise: 300000, recordedAt: new Date() }]
    });
    // Let's set versions
    await loan.save();

    // Create a dummy request/response pattern to test controller
    const resBase = () => ({
        status: function(code) { this.statusCode = code; return this; },
        json: function(data) { this.data = data; return this; }
    });

    // Initiate payment
    const reqInit = {
        params: { id: loan._id },
        body: { amountPaise: 100000, note: 'test' },
        user: { id: lender._id }
    };
    const resInit = resBase();
    await initiatePayment(reqInit, resInit);

    const intentId = resInit.data.intentId;
    
    // Simulate valid OTP bypass
    const challenge = await OtpChallenge.findOne({ intentId });
    // Instead of doing bcrypt, we'll just mock the bcrypt in payments.js or update the hash
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('123456', 10);
    await OtpChallenge.updateOne({ _id: challenge._id }, { otpHash: hash });

    const reqCommit1 = {
        params: { id: loan._id },
        body: { intentId, otp: '123456' },
        user: { id: borrower._id }
    };
    const reqCommit2 = {
        params: { id: loan._id },
        body: { intentId, otp: '123456' },
        user: { id: borrower._id }
    };

    // Send concurrently
    console.log("Sending concurrent commits...");
    const [out1, out2] = await Promise.all([
        new Promise(resolve => {
            const res = resBase();
            res.json = function(data) { this.data = data; resolve({code: this.statusCode, data}); return this; };
            commitPayment(reqCommit1, res);
        }),
        new Promise(resolve => {
            const res = resBase();
            res.json = function(data) { this.data = data; resolve({code: this.statusCode, data}); return this; };
            commitPayment(reqCommit2, res);
        })
    ]);

    console.log("Response 1:", out1.code, out1.data.success ? 'SUCCESS' : out1.data.code);
    console.log("Response 2:", out2.code, out2.data.success ? 'SUCCESS' : out2.data.code);

    const finalLoan = await Loan.findById(loan._id);
    const payments = finalLoan.transactions.filter(t => t.type === 'payment');
    console.log("Total payments recorded:", payments.length);

    await mongoose.connection.close();
}

testConcurrency().catch(console.error);
