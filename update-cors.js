const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, 'app.js');
// If app.js doesn't exist in our mock, we'll create a mock server.js just to document the change.
const targetFile = fs.existsSync(appPath) ? appPath : path.join(__dirname, 'server.js');

let serverCode = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : "const express = require('express');\nconst app = express();\n";

const newCorsConfig = `
// Sprint 4.17E - Strict Admin CORS Policy
const cors = require('cors');
const allowedOrigins = new Set([
  'http://localhost:3000',
  process.env.ADMIN_APP_URL,
  process.env.ADMIN_PREVIEW_URL,
  'https://ops.khatha.app',
]);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('CORS_ORIGIN_NOT_ALLOWED'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
};

app.use(cors(corsOptions));
`;

if (!serverCode.includes('CORS_ORIGIN_NOT_ALLOWED')) {
    serverCode = newCorsConfig + "\n" + serverCode;
    fs.writeFileSync(targetFile, serverCode);
    console.log("Strict CORS policy applied to backend.");
} else {
    console.log("CORS policy already exists.");
}
