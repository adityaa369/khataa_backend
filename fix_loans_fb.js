const fs = require('fs');
let code = fs.readFileSync('controllers/loans.js', 'utf8');

code = code.replace(/const admin = require\('firebase-admin'\);\s*const decodedToken = await admin\.auth\(\)\.verifyIdToken\(idToken\);/g, 
    "const { getAuth } = require('firebase-admin/auth');\n        const decodedToken = await getAuth().verifyIdToken(idToken);");

code = code.replace(/const bucket = admin\.storage\(\)\.bucket\(bucketName\);/g, 
    "const { getStorage } = require('firebase-admin/storage');\n            const bucket = getStorage().bucket(bucketName);");

fs.writeFileSync('controllers/loans.js', code);
