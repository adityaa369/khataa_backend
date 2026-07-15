const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const Loan = require('./models/Loan');
const CreditScore = require('./models/CreditScore');
const connectDB = require('./config/db');

dotenv.config({ path: './.env' });

const seedData = async () => {
    try {
        await connectDB();

        console.log('Cleaning DB...');
        await User.deleteMany({});
        await Loan.deleteMany({});
        await CreditScore.deleteMany({});

        console.log('Creating Users...');

        // 1. Lender (Aditya)
        const lenderId = new mongoose.Types.ObjectId().toString();
        const lender = await User.create({
            id: lenderId, // Explicitly match schema 'id'
            phone: '9876543210',
            firstName: 'Aditya',
            lastName: 'Amruthaluri',
            email: 'aditya@example.com',
            pan: 'ABCDE1234F',
            aadhar: '123456789012',
            dob: '1995-01-01',
            gender: 'Male',
            isVerified: true
        });

        // 2. Borrower 1 (Ganesh)
        const borrower1Id = new mongoose.Types.ObjectId().toString();
        const borrower1 = await User.create({
            id: borrower1Id,
            phone: '9123456780',
            firstName: 'Ganesh',
            lastName: 'Kumar',
            email: 'ganesh@example.com',
            pan: 'FGHIJ5678K',
            isVerified: true
        });

        // 3. Borrower 2 (Ramesh)
        const borrower2Id = new mongoose.Types.ObjectId().toString();
        const borrower2 = await User.create({
            id: borrower2Id,
            phone: '9988776655',
            firstName: 'Ramesh',
            lastName: 'Rao',
            email: 'ramesh@example.com',
            isVerified: true
        });

        console.log('Creating Loans...');

        console.log('Creating Loans...');

        // Loan 1: Aditya gave to Ganesh
        const l1 = await Loan.create({
            lender: lenderId,
            borrower: borrower1Id,
            borrowerName: 'Ganesh Kumar',
            borrowerPhone: '9123456780',
            amount: 50000,
            interestRate: 12,
            durationMonths: 12,
            loanType: 'personal',
            status: 'active',
            progress: 0.25,
            startDate: new Date(new Date().setMonth(new Date().getMonth() - 2)),
            otp: '123456',
            isOtpVerified: true
        });
        console.log('Loan 1 Created:', l1._id);

        // Loan 2: Aditya gave to Ramesh
        const l2 = await Loan.create({
            lender: lenderId,
            borrower: borrower2Id,
            borrowerName: 'Ramesh Rao',
            borrowerPhone: '9988776655',
            amount: 100000,
            interestRate: 10,
            durationMonths: 6,
            loanType: 'business',
            status: 'active',
            progress: 0.05,
            startDate: new Date(new Date().setMonth(new Date().getMonth() - 5)),
            otp: '654321',
            isOtpVerified: true
        });
        console.log('Loan 2 Created:', l2._id);

        // Loan 3: Ganesh gave to Aditya
        const l3 = await Loan.create({
            lender: borrower1Id,
            borrower: lenderId,
            borrowerName: 'Aditya Amruthaluri',
            borrowerPhone: '9876543210',
            amount: 25000,
            interestRate: 0,
            durationMonths: 3,
            loanType: 'personal',
            status: 'active',
            progress: 0.5,
            startDate: new Date(),
            otp: '112233',
            isOtpVerified: true
        });
        console.log('Loan 3 Created:', l3._id);

        // Loan 4: Completed Loan for History
        const l4 = await Loan.create({
            lender: lenderId,
            borrower: borrower1Id,
            borrowerName: 'Ganesh Kumar',
            borrowerPhone: '9123456780',
            amount: 10000,
            interestRate: 12,
            durationMonths: 3,
            loanType: 'personal',
            status: 'completed',
            progress: 1.0,
            startDate: new Date(new Date().setMonth(new Date().getMonth() - 10)),
            otp: '998877',
            isOtpVerified: true
        });
        console.log('Loan 4 Created:', l4._id);

        console.log('Seeding Credit Scores...');
        // Initial Score for Aditya
        await CreditScore.create({
            user: lenderId,
            cibilScore: 750,
            experianScore: 780,
            status: 'Good'
        });

        console.log('Data Seeded Successfully!');
        console.log('Login as Aditya with Phone: 9876543210');
        console.log(`Lender ID: ${lenderId}`);
        process.exit();
    } catch (err) {
        console.error('Error seeding data:', err);
        process.exit(1);
    }
};

seedData();
