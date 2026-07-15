const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const Loan = require('./models/Loan');
const CreditScore = require('./models/CreditScore');

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

async function clearDB() {
    try {
        console.log('Connecting to DB for cleanup...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected!');

        console.log('Clearing Users...');
        await User.deleteMany({});

        console.log('Clearing Loans...');
        await Loan.deleteMany({});

        console.log('Clearing Credit Scores...');
        await CreditScore.deleteMany({});

        console.log('\n--- Database Cleared Successfully! ---');
        console.log('You can now start fresh with a new registration.\n');

        process.exit(0);
    } catch (err) {
        console.error('Error during cleanup:', err);
        process.exit(1);
    }
}

clearDB();
