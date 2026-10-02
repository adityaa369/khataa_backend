const fs = require('fs');
let loansCtrl = fs.readFileSync('controllers/loans.js', 'utf8');

// The security check in createLoan:
const securityCheck = `
        // Verify ownership of uploaded documents in Firebase Storage
        if (documents && documents.length > 0) {
            const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'khaata-42b18.appspot.com';
            const { getStorage } = require('firebase-admin/storage');
            const bucket = getStorage().bucket(bucketName);
            
            for (const docId of documents) {
                if (docId.startsWith('documents/')) {
                    const file = bucket.file(docId);
                    const [exists] = await file.exists();
                    if (!exists) {
                        return res.status(400).json({ success: false, message: \`Document \${docId} does not exist\` });
                    }
                    const [metadata] = await file.getMetadata();
                    if (!metadata.metadata || metadata.metadata.uploadedBy !== req.user.id) {
                        return res.status(403).json({ success: false, message: \`You do not have permission to attach document \${docId}\` });
                    }
                }
            }
        }
`;

if (loansCtrl.includes('const loan = await Loan.create({')) {
    if (!loansCtrl.includes('Verify ownership of uploaded documents')) {
        loansCtrl = loansCtrl.replace(
            '        const loan = await Loan.create({',
            securityCheck + '\n        const loan = await Loan.create({'
        );
        fs.writeFileSync('controllers/loans.js', loansCtrl);
        console.log("Added security check");
    } else {
        console.log("Security check already present");
    }
} else {
    console.log("Could not find insertion point");
}
