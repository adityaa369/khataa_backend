require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

async function purgeUserData() {
    console.log('\n========================================');
    console.log('   KHAATA DATABASE DATA PURGE UTILITY   ');
    console.log('========================================\n');

    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error('Error: MONGODB_URI is not set in environment or .env file.');
        process.exit(1);
    }

    try {
        console.log('[1/4] Connecting to MongoDB...');
        await mongoose.connect(uri);
        const dbName = mongoose.connection.db.databaseName;
        console.log(`[1/4] Connected to database: "${dbName}"`);

        console.log('\n[2/4] Purging documents from all collections (schemas & indexes preserved)...');
        const collections = await mongoose.connection.db.listCollections().toArray();
        const results = [];

        for (const col of collections) {
            const name = col.name;
            if (name.startsWith('system.')) continue;

            const collection = mongoose.connection.db.collection(name);
            const res = await collection.deleteMany({});
            results.push({ collection: name, deletedCount: res.deletedCount });
        }

        console.table(results);

        console.log('[3/4] Purging local uploaded files...');
        const uploadsDir = path.join(__dirname, '../uploads');
        let filesRemoved = 0;
        if (fs.existsSync(uploadsDir)) {
            const files = fs.readdirSync(uploadsDir);
            for (const file of files) {
                if (file !== '.gitkeep') {
                    try {
                        fs.unlinkSync(path.join(uploadsDir, file));
                        filesRemoved++;
                    } catch (e) {
                        console.warn(`Could not delete file ${file}:`, e.message);
                    }
                }
            }
        }
        console.log(`[3/4] Removed ${filesRemoved} uploaded files.`);

        console.log('\n[4/4] Checking Firebase Authentication users...');
        try {
            const admin = require('../config/firebase');
            let nextPageToken;
            let fbCount = 0;
            do {
                const listUsersResult = await admin.auth().listUsers(100, nextPageToken);
                for (const userRecord of listUsersResult.users) {
                    await admin.auth().deleteUser(userRecord.uid);
                    fbCount++;
                }
                nextPageToken = listUsersResult.pageToken;
            } while (nextPageToken);
            console.log(`[4/4] Successfully purged ${fbCount} Firebase Auth users.`);
        } catch (fbErr) {
            console.log(`[4/4] Firebase Auth cleanup skipped (${fbErr.message}).`);
        }

        console.log('\n========================================');
        console.log(' SUCCESS: Database user data purged!');
        console.log(' All schemas, indexes, and collections remain 100% intact.');
        console.log('========================================\n');

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Purge failed with error:', err);
        process.exit(1);
    }
}

purgeUserData();
