require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const admin = require('../config/firebase');

const BACKUP_DIR = path.join(__dirname, '../backups_local');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

async function performBackup() {
    console.log('[Backup] Starting backup process...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('[Backup] Connected to MongoDB');

    const db = mongoose.connection.db;
    const collections = await db.collections();
    
    const backupData = {};
    for (let collection of collections) {
        const name = collection.collectionName;
        console.log(`[Backup] Dumping collection: ${name}`);
        const data = await collection.find({}).toArray();
        backupData[name] = data;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.json.gz.enc`;
    const filepath = path.join(BACKUP_DIR, filename);

    console.log('[Backup] Compressing and encrypting data (AES-256-GCM)...');
    const { EJSON } = require('bson');
    const rawJson = EJSON.stringify(backupData);
    const compressed = zlib.gzipSync(rawJson);

    if (!process.env.BACKUP_ENCRYPTION_KEY) {
        throw new Error('BACKUP_ENCRYPTION_KEY is required but not set in environment.');
    }
    
    // Ensure 32-byte key
    let keyStr = process.env.BACKUP_ENCRYPTION_KEY;
    if (keyStr.length < 32) keyStr = keyStr.padEnd(32, '0');
    const key = Buffer.from(keyStr.slice(0, 32), 'utf8');
    
    // AES-256-GCM uses a 12-byte IV/nonce
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encryptedData = Buffer.concat([cipher.update(compressed), cipher.final()]);
    
    // 16-byte authentication tag
    const authTag = cipher.getAuthTag();

    // Payload format: [IV (12 bytes)] + [AuthTag (16 bytes)] + [EncryptedData]
    const finalPayload = Buffer.concat([iv, authTag, encryptedData]);

    fs.writeFileSync(filepath, finalPayload);
    console.log(`[Backup] Backup saved locally to ${filepath}`);

    // Upload to Firebase Storage
    console.log(`[Backup] Uploading to Firebase Storage...`);
    try {
        const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
        const { getStorage } = require('firebase-admin/storage');
        const bucket = getStorage().bucket(bucketName);
        const destination = `backups/${filename}`;
        
        // Upload with explicit private ACLs to ensure backup objects are never publicly accessible
        await bucket.upload(filepath, { 
            destination, 
            public: false,
            metadata: {
                cacheControl: 'no-cache, no-store, must-revalidate',
                contentType: 'application/octet-stream'
            }
        });
        console.log('[Backup] Upload successful.');
        
        console.log('[Backup] Applying retention policy (30 days)...');
        const [files] = await bucket.getFiles({ prefix: 'backups/' });
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        
        for (const file of files) {
            const [metadata] = await file.getMetadata();
            const created = new Date(metadata.timeCreated).getTime();
            if (created < thirtyDaysAgo) {
                console.log(`[Backup] Deleting old backup: ${file.name}`);
                await file.delete();
            }
        }
    } catch (err) {
        console.log('[Backup] Skipping Firebase upload (credentials likely missing or invalid).');
        console.log('[Backup] Error:', err.message);
    }

    await mongoose.connection.close();
    console.log('[Backup] Backup process completed successfully.');
    return filepath;
}

if (require.main === module) {
    performBackup().then(() => process.exit(0)).catch(err => {
        console.error('[Backup] Failed:', err);
        process.exit(1);
    });
}

module.exports = performBackup;
