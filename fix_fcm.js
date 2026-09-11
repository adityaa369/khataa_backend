const fs = require('fs');
let code = fs.readFileSync('utils/fcm.js', 'utf8');
code = code.replace(/const admin = require\('firebase-admin'\);/g, "const { getMessaging } = require('firebase-admin/messaging');");
code = code.replace(/admin\.messaging\(\)/g, "getMessaging()");
fs.writeFileSync('utils/fcm.js', code);
