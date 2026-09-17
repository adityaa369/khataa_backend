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
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ limit: '5mb', extended: true }));

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
const intentRoutes = require('./routes/intents');
const creditScoreRoutes = require('./routes/creditScore');
const userRoutes = require('./routes/users');
const notificationRoutes = require('./routes/notifications');
const chitFundRoutes = require('./routes/chitFunds');
const documentRoutes = require('./routes/documents');
const adminRoutes = require('./routes/admin');

app.use('/api/auth', authRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/intents', intentRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/credit-score', creditScoreRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/chitfunds', chitFundRoutes);
app.use('/api/admin', adminRoutes);

// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/api/test', (req, res) => res.json({ success: true, message: 'Khaata API is Live' }));
app.get('/api/version', (req, res) => res.json({ success: true, commit: process.env.RENDER_GIT_COMMIT || 'unknown' }));

const { protect } = require('./middleware/auth');
const adminOnly = require('./middleware/adminOnly');
app.get('/api/audit', protect, adminOnly, async (req, res) => {
    try {
        const Loan = require('./models/Loan');
        const loans = ['6aaa8b83fee00a8bb0ace708', '6aaa9f354a72eec9ea0f8c62'];
        let output = '';
        for (const id of loans) {
            output += '--------------------------------------------------\n';
            output += 'LOAN ID: ' + id + '\n';
            const loan = await Loan.findById(id).lean();
            if (!loan) {
                output += 'Not found\n';
                continue;
            }
            output += 'Original Principal (Paise): ' + (loan.amountPaise || loan.amount) + '\n';
            output += 'Transactions:\n';
            let runningPrincipal = loan.amountPaise || (loan.amount * 100) || 0;
            let runningInterest = 0;
            let runningFees = 0;
            const sorted = loan.transactions.sort((a,b) => new Date(a.effectiveAt || a.recordedAt) - new Date(b.effectiveAt || b.recordedAt));
            for (const t of sorted) {
                output += '  Date: ' + t.recordedAt + '\n';
                output += '  ID: ' + t._id + '\n';
                output += '  Type: ' + t.type + '\n';
                output += '  Amount (Paise): ' + t.amountPaise + '\n';
                output += '  Principal Delta: ' + (t.principalAllocationPaise || 0) + '\n';
                output += '  Interest Delta: ' + (t.interestAllocationPaise || 0) + '\n';
                output += '  Fee Delta: ' + (t.feesAllocationPaise || 0) + '\n';
                output += '  Intent/Idempotency Key: ' + (t.intentId || 'N/A') + '\n';
                if (t.type === 'interest_accrued') {
                    runningInterest += t.amountPaise || 0;
                } else if (t.type === 'payment' || t.type === 'interest_payment') {
                    runningPrincipal -= (t.principalAllocationPaise || 0);
                    runningInterest -= (t.interestAllocationPaise || 0);
                    runningFees -= (t.feesAllocationPaise || 0);
                }
                output += '  -> Running Balance: Principal: ' + runningPrincipal + ' Interest: ' + runningInterest + ' Fees: ' + runningFees + '\n';
                output += '  --\n';
            }
        }
        res.type('text/plain').send(output);
    } catch(err) {
        res.status(500).send(err.message);
    }
});

app.get('/api/diagnostic', async (req, res) => {
    const envValue = process.env.FINANCIAL_KILL_SWITCH;
    let mongoKs = null;
    try {
        const mongoose = require('mongoose');
        const FinancialKillSwitch = require('./models/FinancialKillSwitch');
        mongoKs = await FinancialKillSwitch.findOne({ key: 'FINANCIAL' });
    } catch(e) {}
    
    let activeSource = 'NONE (NORMAL)';
    let currentState = 'false';
    let reason = 'N/A';
    let lastUpdated = 'N/A';

    if (envValue === 'true') {
        activeSource = 'RENDER ENVIRONMENT VARIABLE';
        currentState = 'true';
        reason = 'Emergency override via Render Dashboard';
    } else if (mongoKs && mongoKs.enabled) {
        activeSource = 'MONGODB';
        currentState = 'true';
        reason = mongoKs.reason || 'Unknown';
        lastUpdated = mongoKs.updatedAt || 'Unknown';
    }
    
    res.json({ SOURCE: activeSource, CURRENT_STATE: currentState, WHY_IT_IS_ACTIVE: reason, LAST_UPDATED: lastUpdated, SAFE_TO_RESTORE_NORMAL: 'YES' });
});

// ─── Dev-only DB Clear (NEVER in production) ────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
    app.get('/api/dev/clear-db', async (req, res) => {
        const devKey = req.headers['x-dev-key'];
        if (!devKey || devKey !== process.env.DEV_CLEAR_KEY) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        try {
            const collections = mongoose.connection.collections;
            for (const key in collections) {
                await collections[key].deleteMany();
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

app.use('/api/debug', require('./routes/debug'));
