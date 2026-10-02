require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function autoWipe() {
    console.log(`\n=========================================`);
    console.log(`AUTO WIPE: ENABLED — DEVELOPMENT ONLY`);

    // Safeguard 1: Hard production block
    if (process.env.NODE_ENV === 'production') {
        console.error('CRITICAL ERROR: AUTO WIPE IS FORBIDDEN IN PRODUCTION');
        process.exit(1); // Fail closed
    }

    // Safeguard 2: Require explicit enable flag
    if (process.env.AUTO_WIPE_ENABLED !== 'true') {
        console.log('AUTO WIPE: SKIPPED — AUTO_WIPE_ENABLED IS NOT TRUE');
        console.log(`=========================================\n`);
        return;
    }

    if (!MONGODB_URI) {
        console.error('CRITICAL ERROR: MONGODB_URI not provided.');
        process.exit(1);
    }

    try {
        if (!fs.existsSync('./wipe_version.txt')) {
            console.log('AUTO WIPE: SKIPPED — wipe_version.txt NOT FOUND');
            console.log(`=========================================\n`);
            return;
        }

        const targetVersion = parseInt(fs.readFileSync('./wipe_version.txt', 'utf8').trim(), 10);
        if (isNaN(targetVersion)) {
            console.error('CRITICAL ERROR: wipe_version.txt contains invalid number');
            process.exit(1);
        }

        await mongoose.connect(MONGODB_URI);
        const db = mongoose.connection.db;
        const dbName = db.databaseName;

        // Safeguard 3: Verify the database name
        console.log(`\nAUTO-WIPE TARGET`);
        console.log(`environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`database: ${dbName}`);

        const approvedDbName = process.env.APPROVED_WIPE_DB_NAME || 'khatha';
        if (dbName !== approvedDbName) {
            console.error(`\nCRITICAL ERROR: TARGET DATABASE (${dbName}) DOES NOT MATCH APPROVED WIPE DATABASE (${approvedDbName})`);
            process.exit(1);
        }

        const configColl = db.collection('system_config');

        // Initialize state document safely if it doesn't exist
        try {
            await configColl.insertOne({ _id: 'wipe_state', version: 0, status: 'idle' });
        } catch (err) {
            // 11000 is Duplicate Key Error (already exists)
            if (err.code !== 11000) throw err;
        }

        // Safeguard 5: Atomic Version Claim (Distributed Lock)
        // If two Render instances execute simultaneously, only one will match the $lt condition
        const claimResult = await configColl.findOneAndUpdate(
            { _id: 'wipe_state', version: { $lt: targetVersion } },
            { $set: { version: targetVersion, claimedAt: new Date(), status: 'in_progress' } },
            { returnDocument: 'after' }
        );

        // claimResult.value is null if no document matched the query (version already claimed/applied)
        if (!claimResult || !claimResult.value) {
            console.log(`\nAUTO WIPE: SKIPPED — VERSION ALREADY APPLIED`);
            console.log(`=========================================\n`);
            await mongoose.disconnect();
            return;
        }

        console.log(`\n[AutoWipe] Version ${targetVersion} successfully claimed. Initiating wipe...`);

        // Safeguard 7 & 9: Explicit allow-list of disposable application data
        const allowList = [
            'users', 'loans', 'transactions', 'ledgerentries', 'transactionintents', 
            'otps', 'notifications', 'notificationoutboxes', 'devicetokens', 
            'creditscores', 'chitfunds', 'chitgroups', 'chitinvites', 
            'chitsubscriptions', 'chitledgers', 'chitauctions', 'chitbids', 
            'chittransactions', 'fs.files', 'fs.chunks', 'alertrecords'
        ];
        
        let deletedTotal = 0;
        
        for (const name of allowList) {
            try {
                const collection = db.collection(name);
                const count = await collection.countDocuments();
                if (count > 0) {
                    await collection.deleteMany({});
                    deletedTotal += count;
                    console.log(`  - Cleared ${name} (${count} documents)`);
                }
            } catch (e) {
                console.log(`  - Skipping ${name}: not found or inaccessible`);
            }
        }

        // Safeguard 10: Verify collections contain zero records
        for (const name of allowList) {
            try {
                const count = await db.collection(name).countDocuments();
                if (count > 0) {
                    console.error(`\nCRITICAL ERROR: Collection ${name} still has ${count} records after wipe attempt.`);
                    process.exit(1);
                }
            } catch (e) {} // ignore if collection doesn't exist
        }

        // Mark completion
        await configColl.updateOne(
            { _id: 'wipe_state' },
            { $set: { status: 'completed', lastDeleted: deletedTotal } }
        );

        // Safeguard 11: Log only identity and counts
        console.log(`\n[AutoWipe] Database wipe complete. Deleted ${deletedTotal} records across ${allowList.length} collections.`);
        console.log(`=========================================\n`);
        
        await mongoose.disconnect();

    } catch (err) {
        // Safeguard 4 & 6: Fail closed on errors
        console.error('CRITICAL ERROR DURING AUTO-WIPE:', err.message);
        process.exit(1);
    }
}

autoWipe();
