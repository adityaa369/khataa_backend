require('dotenv').config();
const mongoose = require('mongoose');
const Loan = require('./models/Loan');

const DB_URI = process.env.MONGODB_URI;

async function seed() {
    try {
        await mongoose.connect(DB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('Connected to DB');

        const userId = 'user_1781761684630';
        const dummyLenderId = 'mock_lender_999';
        const userName = 'test real';
        const userPhone = '9099090909';

        const newLoan = {
            lender: dummyLenderId,
            borrower: userId,
            borrowerName: userName,
            borrowerPhone: userPhone,
            amount: 250000,
            interestRate: 1.5,
            durationMonths: 36,
            progress: 0.1,
            startDate: new Date('2025-10-01'),
            loanType: 'interest_credit',
            status: 'active',
            chitGroupId: null,
        };

        const inserted = await Loan.create(newLoan);
        console.log('Successfully injected 1 new interest credit loan: ' + inserted._id);
    } catch (e) {
        console.error('Error seeding:', e);
    } finally {
        await mongoose.disconnect();
    }
}
seed();
