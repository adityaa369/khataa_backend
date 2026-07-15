const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

async function checkUsers() {
    try {
        console.log('Connecting to DB...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected!');

        const users = await User.find({});
        console.log('\n--- Registered Users ---');
        console.log(JSON.stringify(users, null, 2));
        console.log('------------------------\n');

        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

checkUsers();
