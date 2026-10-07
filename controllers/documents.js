const GridFSService = require('../services/GridFSService');
const Loan = require('../models/Loan');

exports.downloadDocument = async (req, res) => {
    try {
        const documentId = req.params.id;
        
        let authorized = false;
        let contentType = 'application/octet-stream';
        let contentLength = 0;
        let downloadStream;

        if (documentId.startsWith('documents/')) {
            // Firebase Storage
            const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
            const { getStorage } = require('firebase-admin/storage');
            const bucket = getStorage().bucket(bucketName);
            const file = bucket.file(documentId);
            
            const [exists] = await file.exists();
            if (!exists) return res.status(404).json({ success: false, message: 'Document not found' });
            
            const [metadata] = await file.getMetadata();
            contentType = metadata.contentType || 'application/octet-stream';
            contentLength = metadata.size;
            
            // Check auth
            if (metadata.metadata && metadata.metadata.uploadedBy === req.user.id) {
                authorized = true;
            }
            downloadStream = file.createReadStream();
        } else {
            // GridFS
            const metadata = await GridFSService.getDocumentMetadata(documentId);
            if (!metadata) return res.status(404).json({ success: false, message: 'Document not found' });
            
            contentType = metadata.contentType || 'application/octet-stream';
            contentLength = metadata.length;
            
            if (metadata.metadata && metadata.metadata.uploadedBy === req.user.id) {
                authorized = true;
            }
            downloadStream = GridFSService.downloadDocumentStream(documentId);
        }

        // If not uploader, check if it's attached to a loan they are part of
        if (!authorized) {
            const loan = await Loan.findOne({
                $or: [
                    { documentId: documentId },
                    { documentUrl: documentId },
                    { documentIds: documentId }
                ]
            });

            if (loan && (loan.lender === req.user.id || loan.borrower === req.user.id)) {
                authorized = true;
            }
        }

        if (!authorized) {
            return res.status(403).json({ success: false, message: 'You do not have access to this document' });
        }

        // 3. Stream bytes
        res.set('Content-Type', contentType);
        res.set('Content-Length', contentLength);
        
        downloadStream.on('error', (err) => {
            console.error('[Documents] Stream error:', err.message);
            if (!res.headersSent) {
                res.status(500).end('Error streaming document');
            }
        });

        downloadStream.pipe(res);

    } catch (err) {
        console.error('[Documents] Error:', err.message);
        if (err.name === 'BSONError') {
            return res.status(400).json({ success: false, message: 'Invalid document ID format' });
        }
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
