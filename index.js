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

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20, // 20 auth attempts per 15 min
    message: { success: false, message: 'Too many authentication attempts, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});

app.use('/api', globalLimiter);
app.use('/api/auth', authLimiter);

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
const creditScoreRoutes = require('./routes/creditScore');
const userRoutes = require('./routes/users');
const notificationRoutes = require('./routes/notifications');
const chitFundRoutes = require('./routes/chitFunds');

app.use('/api/auth', authRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/credit-score', creditScoreRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/chitfunds', chitFundRoutes);

// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/api/test', (req, res) => res.json({ success: true, message: 'Khaata API is Live' }));

// ─── Dev-only DB Clear (NEVER in production) ────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
    app.get('/api/dev/clear-db', async (req, res) => {
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
