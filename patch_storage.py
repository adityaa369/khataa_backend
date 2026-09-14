import re
import os

# 1. Modify controllers/loans.js
with open('controllers/loans.js', 'r', encoding='utf-8') as f:
    c = f.read()

# Replace uploadDocument
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

c = re.sub(r'exports\.uploadDocument = async \(req, res, next\) => \{.*?(?=^// @desc|^exports|^$)', new_upload + '\n\n', c, flags=re.DOTALL | re.MULTILINE)

with open('controllers/loans.js', 'w', encoding='utf-8') as f:
    f.write(c)


# 2. Fix pdfGenerator.js
with open('utils/pdfGenerator.js', 'r', encoding='utf-8') as f:
    pdf_c = f.read()

new_pdf = """
                    const filename = 'cert_' + uuidv4() + '.pdf';
                    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
                    const bucket = admin.storage().bucket(bucketName);
                    const file = bucket.file(filename);

                    await file.save(Buffer.concat(buffers), {
                        metadata: { contentType: 'application/pdf' }
                    });

                    // NO makePublic!
                    resolve(filename);
"""
pdf_c = re.sub(r'const filename = `closure_.*?(?=catch \(uploadError\))', new_pdf, pdf_c, flags=re.DOTALL)
with open('utils/pdfGenerator.js', 'w', encoding='utf-8') as f:
    f.write(pdf_c)


# 3. Create controllers/documents.js
docs_c = """const admin = require('firebase-admin');
const Loan = require('../models/Loan');

exports.getDocumentUrl = async (req, res, next) => {
    try {
        const { documentId } = req.params;
        if (!documentId) return res.status(400).json({ success: false, message: 'Missing document ID' });

        const loan = await Loan.findOne({ documentUrl: documentId });
        if (!loan) return res.status(404).json({ success: false, message: 'Document not found' });

        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Unauthorized to view this document' });
        }

        const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
        const bucket = admin.storage().bucket(bucketName);
        const file = bucket.file(documentId);

        const [url] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000 // 15 minutes
        });

        res.status(200).json({ success: true, url });
    } catch (err) {
        next(err);
    }
};
"""
with open('controllers/documents.js', 'w', encoding='utf-8') as f:
    f.write(docs_c)

# 4. Create routes/documents.js
routes_c = """const express = require('express');
const { getDocumentUrl } = require('../controllers/documents');
const { protect } = require('../middleware/auth');
const router = express.Router();

router.get('/:documentId', protect, getDocumentUrl);

module.exports = router;
"""
with open('routes/documents.js', 'w', encoding='utf-8') as f:
    f.write(routes_c)

# 5. Modify routes/loans.js to expose upload-document
with open('routes/loans.js', 'r', encoding='utf-8') as f:
    lr = f.read()
if 'uploadDocument' not in lr:
    lr = lr.replace('cancelLoan', 'cancelLoan,\n    uploadDocument')
    lr = lr.replace("router.post('/',", "router.post('/upload-document', uploadDocument);\nrouter.post('/',")
with open('routes/loans.js', 'w', encoding='utf-8') as f:
    f.write(lr)

# 6. Modify index.js to add /api/documents and remove static uploads
with open('index.js', 'r', encoding='utf-8') as f:
    idx = f.read()

idx = re.sub(r'const uploadsDir =.*?(?=\n\n|\napp)', '', idx, flags=re.DOTALL)
idx = re.sub(r"app\.use\('/uploads', express\.static\(uploadsDir\)\);\n?", "", idx)

if "'./routes/documents'" not in idx:
    idx = idx.replace("app.use('/api/loans', require('./routes/loans'));", "app.use('/api/loans', require('./routes/loans'));\napp.use('/api/documents', require('./routes/documents'));")

with open('index.js', 'w', encoding='utf-8') as f:
    f.write(idx)

print("Patch applied successfully.")
