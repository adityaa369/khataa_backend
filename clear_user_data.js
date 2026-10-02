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
    console.log(`Connected to Database: ${mongoose.connection.db.databaseName}`);

    const db = mongoose.connection.db;

    // Fetch all collections dynamically to ensure we miss nothing (loans, chit funds, users, etc.)
    const collections = await db.listCollections().toArray();
    console.log(`Found ${collections.length} collections. Clearing data...`);

    let totalDeleted = 0;

    for (const collInfo of collections) {
        const name = collInfo.name;
        if (name.startsWith('system.')) continue;

        try {
            const collection = db.collection(name);
            const countBefore = await collection.countDocuments();
            await collection.deleteMany({});
            console.log(` - ${name}: ${countBefore} documents deleted`);
            totalDeleted += countBefore;
        } catch (e) {
            console.log(` - ${name}: skipped (${e.message})`);
        }
    }

    console.log(`\nDone. Deleted ${totalDeleted} documents total. Schema and indexes preserved. All user data cleared.`);
    await mongoose.disconnect();
    process.exit(0);
}

clear().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
});
