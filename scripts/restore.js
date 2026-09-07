require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

async function performRestore(filepath, targetUri) {
    console.log(`[Restore] Starting restore from ${filepath} to ${targetUri}`);
    
    if (!fs.existsSync(filepath)) {
        throw new Error(`Backup file not found: ${filepath}`);
    }

    const encrypted = fs.readFileSync(filepath);
    
    if (!process.env.BACKUP_ENCRYPTION_KEY) {
        throw new Error('BACKUP_ENCRYPTION_KEY is required but not set in environment.');
    }
    
    let keyStr = process.env.BACKUP_ENCRYPTION_KEY;
    if (keyStr.length < 32) keyStr = keyStr.padEnd(32, '0');
    const key = Buffer.from(keyStr.slice(0, 32), 'utf8');
    
    // Extract IV (12 bytes) and AuthTag (16 bytes)
    const iv = encrypted.subarray(0, 12);
    const authTag = encrypted.subarray(12, 28);
    const encryptedData = encrypted.subarray(28);
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let compressed;
    try {
        compressed = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    } catch (err) {
        throw new Error(`Authentication/Decryption failed: ${err.message}. The backup may be tampered with or the key is incorrect.`);
    }
    
    const { EJSON } = require('bson');
    const rawJson = zlib.gunzipSync(compressed).toString('utf8');
    const backupData = EJSON.parse(rawJson);

    await mongoose.connect(targetUri);
    console.log('[Restore] Connected to target MongoDB');

    const db = mongoose.connection.db;
    
    for (const [collectionName, data] of Object.entries(backupData)) {
        console.log(`[Restore] Restoring collection: ${collectionName} (${data.length} documents)`);
        const collection = db.collection(collectionName);
        
        // Clear existing data in target DB
        await collection.deleteMany({});
        
        if (data.length > 0) {
            // EJSON natively preserves ObjectIds, Dates, and other BSON types!
            await collection.insertMany(data);
        }
    }

    await mongoose.connection.close();
    console.log('[Restore] Restore process completed successfully.');
}

if (require.main === module) {
    const file = process.argv[2];
    const targetUri = process.argv[3];
    if (!file || !targetUri) {
        console.error('Usage: node restore.js <path-to-backup.json.gz.enc> <target-mongodb-uri>');
        process.exit(1);
    }
    
    performRestore(file, targetUri).then(() => process.exit(0)).catch(err => {
        console.error('[Restore] Failed:', err);
        process.exit(1);
    });
}

module.exports = performRestore;
