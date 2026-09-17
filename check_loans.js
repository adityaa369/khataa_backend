const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Loan = require('./models/Loan');
const User = require('./models/User');
const connectDB = require('./config/db');

dotenv.config({ path: './.env' });

const checkLoans = async () => {
    try {
        await connectDB();
        const userCount = await User.countDocuments();
        const loanCount = await Loan.countDocuments();
        console.log(`Users in DB: ${userCount}`);
        console.log(`Loans in DB: ${loanCount}`);

        if (loanCount > 0) {
            const loans = await Loan.find({});
            console.log('Sample Loan:', JSON.stringify(loans[0], null, 2));
        }

        process.exit();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

checkLoans();
