require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function autoWipe() {
    if (!MONGODB_URI) {
        console.log('[AutoWipe] Skipping: No MONGODB_URI provided.');
        return;
    }

    try {
        if (!fs.existsSync('./wipe_version.txt')) {
            return;
        }

        const targetVersionStr = fs.readFileSync('./wipe_version.txt', 'utf8').trim();
        const targetVersion = parseInt(targetVersionStr, 10);
        
        if (isNaN(targetVersion)) {
            return;
        }

        await mongoose.connect(MONGODB_URI);
        const db = mongoose.connection.db;

        const configColl = db.collection('system_config');
        const config = await configColl.findOne({ _id: 'wipe_state' });
        const currentVersion = config ? config.version : 0;

        if (targetVersion > currentVersion) {
            console.log(`\n=========================================`);
            console.log(`[AutoWipe] New wipe version detected (${targetVersion} > ${currentVersion}).`);
            console.log(`[AutoWipe] Wiping user data...`);
            
            let deletedTotal = 0;
            const collections = await db.listCollections().toArray();
            
            for (const collInfo of collections) {
                const name = collInfo.name;
                // Preserve system config and internal mongo collections
                if (name.startsWith('system') || name === 'system_config') continue;
                
                try {
                    const count = await db.collection(name).countDocuments();
                    await db.collection(name).deleteMany({});
                    if (count > 0) {
                        console.log(`  - Cleared ${name} (${count} documents)`);
                    }
                    deletedTotal += count;
                } catch (e) {
                    console.log(`  - Failed to clear ${name}: ${e.message}`);
                }
            }

            await configColl.updateOne(
                { _id: 'wipe_state' },
                { $set: { version: targetVersion, wipedAt: new Date(), lastDeleted: deletedTotal } },
                { upsert: true }
            );

            console.log(`[AutoWipe] Database wipe complete. Deleted ${deletedTotal} documents.`);
            console.log(`=========================================\n`);
        } else {
            console.log(`[AutoWipe] State unchanged (Version ${currentVersion}). Skipping wipe.`);
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error('[AutoWipe] Error during execution:', err.message);
    }
}

autoWipe();
