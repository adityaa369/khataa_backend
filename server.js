
// ---------------------------------------------------------
// F.9: PRODUCTION CONTAMINATION GUARD
// ---------------------------------------------------------
if (process.env.NODE_ENV === 'staging') {
    const mongoUri = process.env.MONGO_URI || '';
    const redisUrl = process.env.REDIS_URL || '';
    
    // Fail immediately if missing
    if (!mongoUri || !redisUrl) {
        console.error('STAGING FATAL: Missing infrastructure credentials.');
        process.exit(1);
    }
    
    const prodIdentifiers = ['prod', 'production', 'khataa-prod'];
    
    const isContaminated = prodIdentifiers.some(id => 
        mongoUri.toLowerCase().includes(id) || redisUrl.toLowerCase().includes(id)
    );
    
    if (isContaminated) {
        console.error('STAGING FATAL: Production contamination detected in staging environment variables.');
        console.error('Refusing to boot staging server with production infrastructure.');
        process.exit(1);
    }
    
    console.log('STAGING ENV VALIDATED: Infrastructure successfully isolated.');
}
// ---------------------------------------------------------

// Sprint 4.17E - Strict Admin CORS Policy
const cors = require('cors');
const allowedOrigins = new Set([
  'http://localhost:3000',
  process.env.ADMIN_APP_URL,
  process.env.ADMIN_PREVIEW_URL,
  'https://ops.khatha.app',
  'https://khataa.in',
  'https://www.khataa.in',
  'https://app.khataa.in',
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

const express = require('express');
const app = express();

app.use(cors(corsOptions));
