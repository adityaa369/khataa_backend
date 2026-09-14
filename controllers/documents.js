const GridFSService = require('../services/GridFSService');
const Loan = require('../models/Loan');

exports.downloadDocument = async (req, res) => {
    try {
        const documentId = req.params.id;
        
        // 1. Get metadata to check if exists
        const metadata = await GridFSService.getDocumentMetadata(documentId);
        if (!metadata) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }

        // 2. Authorize
        // The user must be the uploader, OR the lender/borrower of the loan that owns this document.
        let authorized = false;
        
        if (metadata.metadata && metadata.metadata.uploadedBy === req.user.id) {
            authorized = true;
        }

        // If not uploader, check if it's attached to a loan they are part of
        if (!authorized) {
            // Because Loan has documentUrl or documentId, let's check:
            const loan = await Loan.findOne({
                $or: [
                    { documentId: documentId },
                    { documentUrl: documentId } // some legacy fields might have stored id here
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
        res.set('Content-Type', metadata.contentType || 'application/octet-stream');
        res.set('Content-Length', metadata.length);
        
        const downloadStream = GridFSService.downloadDocumentStream(documentId);
        
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
