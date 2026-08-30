const admin = require('firebase-admin');
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
