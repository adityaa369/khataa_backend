
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
