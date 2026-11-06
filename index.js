const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const http = require('http');

dotenv.config();

const app = express();

// Trust the reverse proxy (Render) so rate limiting works correctly
app.set('trust proxy', 1);


// ─── Security Headers ───────────────────────────────────────────────────────
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow uploads to load
    contentSecurityPolicy: false, // mobile API, not a browser app
}));

// ─── CORS ───────────────────────────────────────────────────────────────────
const allowedOrigins = [
    'https://khataa-backend.onrender.com',
    // Add your future web dashboard URL here if needed
];
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Rate Limiting ──────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    message: { success: false, message: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api', globalLimiter);

// ─── Body Parsing ───────────────────────────────────────────────────────────
app.use(compression());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// ─── NoSQL Injection & Parameter Pollution Protection ───────────────────────
app.use(mongoSanitize()); // strips $, . from request body/params/query
app.use(hpp());           // removes duplicate query params

// ─── Static Files ───────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// ─── Ensure req.body always exists ──────────────────────────────────────────
app.use((req, res, next) => {
    req.body = req.body || {};
    next();
});

// ─── Request Logging (scrub sensitive fields) ───────────────────────────────
app.use((req, res, next) => {
    if (process.env.NODE_ENV !== 'production') {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            const safeBody = { ...req.body };
            if (safeBody.otp) safeBody.otp = '****';
            if (safeBody.accessToken) safeBody.accessToken = '****';
            if (safeBody.password) safeBody.password = '****';
            console.log('Body:', JSON.stringify(safeBody));
        }
    }
    next();
});

// ─── Routes ─────────────────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const loanRoutes = require('./routes/loans');
const creditScoreRoutes = require('./routes/creditScore');
const userRoutes = require('./routes/users');
const notificationRoutes = require('./routes/notifications');
const chitFundRoutes = require('./routes/chitFunds');
const documentRoutes = require('./routes/documents');
const adminRoutes = require('./routes/admin');
const intentRoutes = require('./routes/intents');

app.use('/api/auth', authRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/credit-score', creditScoreRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/chitfunds', chitFundRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/intents', intentRoutes);

// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/api/test', (req, res) => res.json({ success: true, message: 'Khaata API is Live' }));
app.get('/api/version', (req, res) => res.json({ success: true, commit: process.env.RENDER_GIT_COMMIT || 'f32efdc', version: '1.0.0', environment: process.env.NODE_ENV || 'production' }));

// ─── Public Legal & Account Deletion Pages (Google Play & DPDP Act 2023) ────
app.get('/privacy-policy', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandCredit — Privacy Policy</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1f2937;max-width:760px;margin:0 auto;padding:32px 20px;background:#fefdf8}h1{color:#059669}h2{color:#111827;margin-top:24px}.card{background:#fff;padding:28px;border-radius:16px;border:1px solid #e5e7eb;box-shadow:0 4px 12px rgba(0,0,0,0.03)}</style></head><body><div class="card"><h1>HandCredit — Privacy Policy</h1><p><strong>Effective Date:</strong> October 2026 | <strong>Compliance:</strong> India DPDP Act, 2023 & IT Rules, 2011</p><h2>1. Nature of Platform (Non-Lender Notice)</h2><p>HandCredit is strictly a digital bookkeeping and mutual agreement record utility. HandCredit is NOT a bank, NBFC, or lender, and does NOT provide, disburse, or facilitate loans.</p><h2>2. Data Collected</h2><p>We collect account registration details (name, mobile number, email, date of birth, gender, city/address) and user-recorded ledger entries and proof documents voluntarily uploaded by counterparties.</p><h2>3. Data Security & Usage</h2><p>All data is transmitted over encrypted HTTPS/TLS connections and used solely to maintain your mutual digital ledger, generate No Dues Certificates (NOC), and deliver transactional notifications. We never sell personal data to third parties.</p><h2>4. Account & Data Deletion</h2><p>Users may permanently delete their account and personal data at any time from inside the HandCredit app via <strong>Profile &rarr; Account Management &rarr; Delete Account</strong>, or by visiting <a href="/delete-account">/delete-account</a>.</p><h2>5. Grievance Officer</h2><p>Email: support@handcredit.in (Response within 48 hours; resolution within 15 days).</p></div></body></html>`);
});

app.get('/terms', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandCredit — Terms of Service</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1f2937;max-width:760px;margin:0 auto;padding:32px 20px;background:#fefdf8}h1{color:#059669}h2{color:#111827;margin-top:24px}.card{background:#fff;padding:28px;border-radius:16px;border:1px solid #e5e7eb;box-shadow:0 4px 12px rgba(0,0,0,0.03)}</style></head><body><div class="card"><h1>HandCredit — Terms of Service</h1><p><strong>1. Digital Bookkeeping Utility Only:</strong> HandCredit is a peer-to-peer ledger record utility and is not an RBI-regulated lender, bank, or NBFC. HandCredit does not lend money or facilitate loans.</p><p><strong>2. Mutual Confirmation:</strong> All ledger entries and repayment records are mutually confirmed by the participating users.</p><p><strong>3. Governing Law:</strong> Governed by the laws of the Republic of India.</p></div></body></html>`);
});

app.get('/delete-account', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandCredit — Account & Data Deletion</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1f2937;max-width:760px;margin:0 auto;padding:32px 20px;background:#fefdf8}h1{color:#dc2626}.card{background:#fff;padding:28px;border-radius:16px;border:1px solid #e5e7eb;box-shadow:0 4px 12px rgba(0,0,0,0.03)}</style></head><body><div class="card"><h1>HandCredit — Account & Personal Data Deletion</h1><p>In accordance with Google Play Store Data Safety requirements and India's Digital Personal Data Protection Act (DPDP Act 2023), you can permanently delete your HandCredit account and associated personal data using either method below:</p><h3>Method 1: Instant In-App Deletion</h3><ol><li>Open the <strong>HandCredit</strong> mobile app and sign in.</li><li>Tap your profile icon at the top-right to open <strong>Profile</strong>.</li><li>Tap <strong>Account Management &rarr; Delete Account Permanently</strong> and confirm.</li></ol><h3>Method 2: Web / Email Deletion Request</h3><p>If you no longer have the app installed, send an email from your registered email address or mobile number to <strong>support@handcredit.in</strong> with the subject line <code>DELETE MY HANDCREDIT ACCOUNT</code>. Your profile, credentials, and personal data will be erased within 7 business days (subject to zero active unsettled ledger obligations).</p></div></body></html>`);
});

// ─── Dev-only DB Clear (NEVER in production) ────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
    app.get('/api/dev/clear-db', async (req, res) => {
        const devKey = req.headers['x-dev-key'];
        if (!devKey || devKey !== process.env.DEV_CLEAR_KEY) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        try {
            const collections = await mongoose.connection.db.listCollections().toArray();
            for (const collInfo of collections) {
                if (!collInfo.name.startsWith('system.')) {
                    await mongoose.connection.db.collection(collInfo.name).deleteMany({});
                }
            }
            res.json({ success: true, message: 'Database cleared (dev only).' });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });
}

// ─── Global Error Handler ───────────────────────────────────────────────────
app.use((err, req, res, next) => {
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ success: false, message: 'CORS policy violation' });
    }
    if (process.env.NODE_ENV !== 'production') {
        console.error(`[GLOBAL ERROR] ${req.method} ${req.url}:`, err.message);
    }
    res.status(500).json({ success: false, message: 'Internal Server Error' });
});

// ─── MongoDB Connection ─────────────────────────────────────────────────────
const initAuctionEngine = require('./sockets/auctionEngine');

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGODB_URI;

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('\n--- MongoDB Connection ---');
        console.log('SUCCESS: Connected to MongoDB Atlas Cluster');
        console.log('------------------------\n');

        const server = http.createServer(app);
        
        // Initialize WebSockets for Live Auctions
        initAuctionEngine(server);

                // Start Background Workers
        const NotificationWorker = require('./workers/NotificationWorker');
        const InterestAccrualWorker = require('./workers/InterestAccrualWorker');
        const PaymentReminderWorker = require('./workers/PaymentReminderWorker');
        const OperationalStateMonitor = require('./workers/OperationalStateMonitor');
        const ReconciliationEngine = require('./workers/ReconciliationEngine');

        setInterval(() => NotificationWorker.processOutbox().catch(console.error), 10 * 1000); // 10s
        setInterval(() => InterestAccrualWorker.runDailyAccrual().catch(console.error), 60 * 60 * 1000); // 1h
        setInterval(() => PaymentReminderWorker.runDailyReminders().catch(console.error), 60 * 60 * 1000); // 1h
        setInterval(() => OperationalStateMonitor.runMonitor().catch(console.error), 5 * 60 * 1000); // 5m
        setInterval(() => ReconciliationEngine.runReconciliation().catch(console.error), 60 * 60 * 1000); // 1h
        
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`\n--- Khaata Server Live ---`);
            console.log(`Port: ${PORT}`);
            console.log(`Mode: ${process.env.NODE_ENV || 'Development'}`);
            console.log(`Local IP: http://localhost:${PORT}`);
            console.log(`WebSockets: Attached & Running`);
            console.log(`-------------------------\n`);
        });
    })
    .catch(err => {
        console.error('\n--- MongoDB Connection ERROR ---');
        console.error('FAILED to connect to MongoDB Atlas.');
        console.error('Message:', err.message);
        console.error('\nPOSSIBLE SOLUTIONS:');
        console.error('1. Check if your IP is whitelisted in Atlas Network Access');
        console.error('2. Ensure the MONGODB_URI in .env is correct');
        console.error('------------------------------\n');
        process.exit(1);
    });
