/**
 * Migration: Change all user_<timestamp> IDs to crypto.randomUUID()
 * Run once: node scripts/migrateUserIds.js
 */
require('dotenv').config({ path: '../.env' });
const mongoose = require('mongoose');
const crypto = require('crypto');

async function migrate() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const users = db.collection('users');
    const loans = db.collection('loans');
    const chitfunds = db.collection('chitfunds');
    const chitsubscriptions = db.collection('chitsubscriptions');
    const notifications = db.collection('notifications');
    const creditscores = db.collection('creditscores');

    const allUsers = await users.find({ id: /^user_\d+$/ }).toArray();
    console.log(`Found ${allUsers.length} users with timestamp IDs`);

    for (const user of allUsers) {
        const oldId = user.id;
        const newId = crypto.randomUUID();
        console.log(`Migrating ${oldId} -> ${newId}`);

        // Update user
        await users.updateOne({ _id: user._id }, { $set: { id: newId } });

        // Update references in loans
        await loans.updateMany({ lender: oldId }, { $set: { lender: newId } });
        await loans.updateMany({ borrower: oldId }, { $set: { borrower: newId } });

        // Update chit fund references
        await chitfunds.updateMany({ owner: oldId }, { $set: { owner: newId } });
        await chitsubscriptions.updateMany({ user: oldId }, { $set: { user: newId } });

        // Update notification references
        await notifications.updateMany({ userId: oldId }, { $set: { userId: newId } });
        await creditscores.updateMany({ userId: oldId }, { $set: { userId: newId } });
    }

    console.log('Migration complete!');
    await mongoose.disconnect();
}

migrate().catch(err => { console.error(err); process.exit(1); });
