const fs = require('fs');
let loansCtrl = fs.readFileSync('controllers/loans.js', 'utf8');

if (!loansCtrl.includes('exports.deleteDocument')) {
    const deleteDocumentLogic = `

// @desc    Delete document (cleanup orphaned uploads)
// @route   POST /api/loans/delete-document
// @access  Private
exports.deleteDocument = async (req, res) => {
    try {
        const { documentId } = req.body;
        if (!documentId) return res.status(400).json({ success: false, message: 'Missing documentId' });

        if (documentId.startsWith('documents/')) {
            const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
            const { getStorage } = require('firebase-admin/storage');
            const bucket = getStorage().bucket(bucketName);
            const file = bucket.file(documentId);
            
            const [exists] = await file.exists();
            if (exists) {
                const [metadata] = await file.getMetadata();
                if (metadata.metadata && metadata.metadata.uploadedBy === req.user.id) {
                    await file.delete();
                    console.log(\`[Cleanup] Deleted orphaned document \${documentId}\`);
                    return res.status(200).json({ success: true, message: 'Document deleted' });
                } else {
                    console.warn(\`[Security] User \${req.user.id} attempted to delete document \${documentId} owned by another user\`);
                    return res.status(403).json({ success: false, message: 'Unauthorized' });
                }
            } else {
                return res.status(404).json({ success: false, message: 'Document not found' });
            }
        } else {
            return res.status(400).json({ success: false, message: 'Invalid documentId format' });
        }
    } catch (err) {
        console.error('[Cleanup] Error deleting document:', err.message);
        return res.status(500).json({ success: false, message: 'Server error during cleanup' });
    }
};
`;
    loansCtrl += deleteDocumentLogic;
    fs.writeFileSync('controllers/loans.js', loansCtrl);
}

let loansRoutes = fs.readFileSync('routes/loans.js', 'utf8');
if (!loansRoutes.includes('/delete-document')) {
    loansRoutes = loansRoutes.replace(
        "router.post('/upload-document', protect, loansController.uploadDocument);",
        "router.post('/upload-document', protect, loansController.uploadDocument);\nrouter.post('/delete-document', protect, loansController.deleteDocument);"
    );
    fs.writeFileSync('routes/loans.js', loansRoutes);
}

console.log("Appended deleteDocument");
