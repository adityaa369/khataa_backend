const fs = require('fs');
let code = fs.readFileSync('controllers/documents.js', 'utf8');
code = code.replace(/const admin = require\('firebase-admin'\);\n/g, "");
code = code.replace(/const bucket = admin\.storage\(\)\.bucket\(bucketName\);/g, 
    "const { getStorage } = require('firebase-admin/storage');\n        const bucket = getStorage().bucket(bucketName);");
fs.writeFileSync('controllers/documents.js', code);
