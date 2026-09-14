// clear_user_data.js — run with: node clear_user_data.js
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGODB_URI) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
}

async function clear() {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected.');

    const db = mongoose.connection.db;

    const collections = [
        'users',
        'otps',
        'loans',
        'financialtransactions',
        'transactionintents',
        'fs.files',
        'fs.chunks',
        'notifications',
    ];

    for (const name of collections) {
        try {
            const result = await db.collection(name).deleteMany({});
            console.log(`✅ ${name}: ${result.deletedCount} documents deleted`);
        } catch (e) {
            console.log(`⚠️  ${name}: skipped (${e.message})`);
        }
    }

    console.log('\nDone. Schema and indexes preserved. All user data cleared.');
    await mongoose.disconnect();
    process.exit(0);
}

clear().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
});
