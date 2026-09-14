const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const Admin = require('./models/Admin');
const connectDB = require('./config/db');

dotenv.config({ path: './.env' });

const seedAdmin = async () => {
    try {
        await connectDB();
        const email = 'operator@khatha.app';
        const password = 'operator123';
        const hash = await bcrypt.hash(password, 10);
        
        await Admin.deleteOne({ email });
        const admin = await Admin.create({
            email: email,
            passwordHash: hash,
            role: 'SUPER_ADMIN',
            mfaEnabled: false
        });
        console.log('Admin seeded successfully:');
        console.log('Email:', email);
        console.log('Password:', password);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

seedAdmin();
