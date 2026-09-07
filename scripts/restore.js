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
    
    let keyStr = process.env.ENCRYPTION_KEY || 'default_32_byte_secret_key_12345';
    if (keyStr.length < 32) keyStr = keyStr.padEnd(32, '0');
    const key = Buffer.from(keyStr.slice(0, 32), 'utf8');
    
    const iv = encrypted.subarray(0, 16);
    const encryptedData = encrypted.subarray(16);
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const compressed = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    
    const rawJson = zlib.gunzipSync(compressed).toString('utf8');
    const backupData = JSON.parse(rawJson);

    await mongoose.connect(targetUri);
    console.log('[Restore] Connected to target MongoDB');

    const db = mongoose.connection.db;
    
    for (const [collectionName, data] of Object.entries(backupData)) {
        console.log(`[Restore] Restoring collection: ${collectionName} (${data.length} documents)`);
        const collection = db.collection(collectionName);
        
        // Clear existing data in target DB
        await collection.deleteMany({});
        
        if (data.length > 0) {
            // Need to convert _id strings back to ObjectIds if they were ObjectIds
            // JSON.stringify serializes ObjectId to string. 
            // In a real robust restore, we'd use BSON, but for this basic mechanism, 
            // we will let MongoDB handle it or explicitly cast _ids.
            const { ObjectId } = require('mongodb');
            const parsedData = data.map(doc => {
                if (doc._id && typeof doc._id === 'string' && doc._id.length === 24) {
                    doc._id = new ObjectId(doc._id);
                }
                return doc;
            });
            await collection.insertMany(parsedData);
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
