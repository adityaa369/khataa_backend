require('dotenv').config();
const mongoose = require('mongoose');
const Loan = require('./models/Loan');

const DB_URI = process.env.MONGODB_URI;

async function seed() {
    try {
        await mongoose.connect(DB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('Connected to DB');

        const userId = 'user_1781761684630';

        await Loan.deleteMany({
            $or: [
                { borrower: userId },
                { lender: userId }
            ]
        });
        console.log('Deleted existing loans for user');

        const dummyLenderId = 'mock_lender_999';
        const userName = 'test real';
        const userPhone = '9099090909';

        const mockLoans = [
            {
                lender: dummyLenderId,
                borrower: userId,
                borrowerName: userName,
                borrowerPhone: userPhone,
                amount: 50000,
                durationMonths: 6,
                progress: 0.16,
                startDate: new Date('2026-05-01'),
                loanType: 'hand_credit',
                status: 'active',
                chitGroupId: null,
            },
            {
                lender: dummyLenderId,
                borrower: userId,
                borrowerName: userName,
                borrowerPhone: userPhone,
                amount: 100000,
                durationMonths: 12,
                progress: 0.25,
                startDate: new Date('2026-03-15'),
                loanType: 'business_credit',
                status: 'active',
                chitGroupId: null,
            },
            {
                lender: dummyLenderId,
                borrower: userId,
                borrowerName: userName,
                borrowerPhone: userPhone,
                amount: 75000,
                interestRate: 2.0,
                durationMonths: 24,
                progress: 0.05,
                startDate: new Date('2026-06-01'),
                loanType: 'interest_credit',
                status: 'active',
                chitGroupId: null,
            }
        ];

        const inserted = await Loan.insertMany(mockLoans);
        console.log('Successfully seeded ' + inserted.length + ' mock loans.');
    } catch (e) {
        console.error('Error seeding:', e);
    } finally {
        await mongoose.disconnect();
    }
}
seed();
