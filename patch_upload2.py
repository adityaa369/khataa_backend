import re

with open('controllers/loans.js', 'r', encoding='utf-8') as f:
    c = f.read()

new_upload = """exports.uploadDocument = async (req, res, next) => {
    try {
        const { fileName, fileType, base64Data } = req.body;
        const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'];
        const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
        
        const sanitizedName = (fileName || 'document').replace(/[^a-zA-Z0-9._\\-]/g, '_').replace(/\\.\\./g, '').substring(0, 100);
        const ext = require('path').extname(sanitizedName).toLowerCase();
        
        if (!ALLOWED_EXTENSIONS.includes(ext)) return res.status(400).json({ success: false, message: 'File type not allowed' });
        if (!ALLOWED_MIME_TYPES.includes(fileType)) return res.status(400).json({ success: false, message: 'Invalid file MIME type' });
        
        const estimatedSize = (base64Data.length * 3) / 4;
        if (estimatedSize > 4 * 1024 * 1024) return res.status(400).json({ success: false, message: 'File too large' });
        if (!base64Data) return res.status(400).json({ success: false, message: 'Please provide base64Data' });

        const buffer = Buffer.from(base64Data, 'base64');
        const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
        const admin = require('firebase-admin');
        const bucket = admin.storage().bucket(bucketName);
        
        const documentId = 'kyc_' + require('uuid').v4() + ext;
        const file = bucket.file(documentId);

        await file.save(buffer, {
            metadata: { contentType: fileType || 'image/jpeg' }
        });
        
        // NO makePublic!
        return res.status(200).json({ success: true, url: documentId });
    } catch (err) {
        // No local fallback to public directory!
        return res.status(500).json({ success: false, message: 'Storage unavailable. Upload failed.' });
    }
};"""

start_idx = c.find('exports.uploadDocument = async')
next_exports_idx = c.find('exports.recordPayment = async')
desc_idx = c.rfind('// @desc', 0, next_exports_idx)

c = c[:start_idx] + new_upload + '\n\n' + c[desc_idx:]

with open('controllers/loans.js', 'w', encoding='utf-8') as f:
    f.write(c)

print("Patch applied successfully.")
