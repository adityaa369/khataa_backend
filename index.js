
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

const express = require('express');
// Override global console to enforce strict PII redaction across the entire app
const logger = require('./utils/logger');
global.console = { ...global.console, ...logger };
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

const { validateConfig } = require('./utils/configValidator');
validateConfig(); // Fatally exit if required env vars are missing

const redisClient = require('./utils/redisClient');

const app = express();
app.set('trust proxy', 1);
const requestCorrelation = require('./middleware/requestCorrelation');
app.use(requestCorrelation);
const { metricsMiddleware, getMetricsSnapshot } = require('./middleware/metrics');
app.use(metricsMiddleware);

// â”€â”€â”€ Security Headers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow uploads to load
    contentSecurityPolicy: false, // mobile API, not a browser app
}));

// â”€â”€â”€ CORS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Rate Limiting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    message: { success: false, message: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        const { triggerAlert } = require('./utils/telemetry');
        triggerAlert('RATE_LIMIT_EXCEEDED', 'MEDIUM', { key: 'global_api_limit', ip: req.ip, originalUrl: req.originalUrl, source: 'EXPRESS_RATE_LIMIT' });
        res.status(options.statusCode).json(options.message);
    }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Too many authentication attempts, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res, next, options) => {
        const { triggerAlert } = require('./utils/telemetry');
        triggerAlert('RATE_LIMIT_EXCEEDED', 'MEDIUM', { key: 'auth_api_limit', ip: req.ip, originalUrl: req.originalUrl, source: 'EXPRESS_RATE_LIMIT' });
        res.status(options.statusCode).json(options.message);
    }
});

const financialKillSwitch = require('./middleware/financialKillSwitch');
app.use(financialKillSwitch);
app.use('/api', globalLimiter);
app.use('/api/auth', authLimiter);

// ---------------- Readiness & Liveness ----------------
let isShuttingDown = false;
let isReady = false;

app.get('/health/metrics', (req, res) => res.json(getMetricsSnapshot()));

app.get('/health/live', (req, res) => {
    res.status(200).send('OK');
});

app.get('/health/ready', async (req, res) => {
    if (isShuttingDown || !isReady) {
        return res.status(503).json({ status: 'UNAVAILABLE', reason: 'Shutting down or booting' });
    }
    
    // Check MongoDB
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ status: 'UNAVAILABLE', reason: 'MongoDB disconnected' });
    }
    
        // Check Redis
    try {
        const { isRedisAvailable } = require('./config/redis');
        if (!isRedisAvailable()) throw new Error('Redis not ready');
    } catch (e) {
        return res.status(503).json({ status: 'UNAVAILABLE', reason: 'Redis disconnected' });
    }
    
    res.status(200).json({ status: 'READY', memoryUsage: process.memoryUsage() });
});

// Reject new requests gracefully during shutdown
app.use((req, res, next) => {
    if (isShuttingDown) {
        res.set('Connection', 'close');
        return res.status(503).send('Server is in the process of restarting.');
    }
    next();
});

// â”€â”€â”€ Body Parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(compression());
app.use(bodyParser.json({ limit: '100kb' }));
app.use(bodyParser.urlencoded({ limit: '100kb', extended: true }));

// â”€â”€â”€ NoSQL Injection & Parameter Pollution Protection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(mongoSanitize()); // strips $, . from request body/params/query
app.use(hpp());           // removes duplicate query params

// â”€â”€â”€ Static Files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const path = require('path');
const fs = require('fs');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// â”€â”€â”€ Ensure req.body always exists â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((req, res, next) => {
    req.body = req.body || {};
    next();
});

// â”€â”€â”€ Request Logging (scrub sensitive fields) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const loanRoutes = require('./routes/loans');
const creditScoreRoutes = require('./routes/creditScore');
const userRoutes = require('./routes/users');
const notificationRoutes = require('./routes/notifications');
const chitFundRoutes = require('./routes/chitFunds');


app.get('/api/health/env', (req, res) => {
    res.json({
        environment: process.env.NODE_ENV || 'development',
        status: 'OPERATIONS NORMAL',
        timestamp: new Date().toISOString()
    });
});

app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/credit-score', creditScoreRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/chitfunds', chitFundRoutes);

// â”€â”€â”€ Health Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/dev/redis-status', (req, res) => { try { const { getRedisClient, isRedisAvailable } = require('./config/redis'); const client = getRedisClient(); res.json({ available: isRedisAvailable(), status: client ? client.status : 'null' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/test', (req, res) => res.json({ success: true, message: 'Khaata API is Live' }));

// â”€â”€â”€ Dev-only DB Clear (NEVER in production) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Global Error Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((err, req, res, next) => {
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ success: false, message: 'CORS policy violation' });
    }
    if (process.env.NODE_ENV !== 'production') {
        console.error(`[GLOBAL ERROR] ${req.method} ${req.url}:`, err.message);
    }
    res.status(500).json({ success: false, message: 'Internal Server Error' });
});

// â”€â”€â”€ MongoDB Connection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const initAuctionEngine = require('./sockets/auctionEngine');

const PORT = process.env.PORT || 5000;

let server;

async function bootServer() {
    try {
        // Production Mongoose Connection Options
        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000, 
            connectTimeoutMS: 10000,
            maxPoolSize: 15,
            socketTimeoutMS: 45000,
            heartbeatFrequencyMS: 10000
        });
        console.log('[DB] MongoDB Connected for Production');

        // Redis is strictly initialized
        if (process.env.NODE_ENV === 'production') {
            try {
                const { connectRedisStrict } = require('./config/redis');
                await connectRedisStrict();
            } catch (error) {
                console.error('[STARTUP] CRITICAL: Production Redis unavailable.');
                process.exit(1);
            }
        }
        server = http.createServer(app);
        
        // Initialize WebSockets for Live Auctions
        const { initAuctionEngine, getIo } = require('./sockets/auctionEngine');
        initAuctionEngine(server);

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`\n--- Khaata Server Live ---`);
            console.log(`Port: ${PORT}`);
            console.log(`Mode: ${process.env.NODE_ENV || 'Development'}`);
            console.log(`WebSockets: Attached & Running`);
            
            isReady = true;
            if (process.send) {
                process.send('ready'); // Signal to PM2 that we can accept traffic
            }
        });

    } catch (err) {
        console.error('Fatal boot error:', err.message);
        process.exit(1);
    }
}

bootServer();

// ---------------- Graceful Shutdown ----------------
function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[SHUTDOWN] Received ${signal}. Draining traffic...`);

    // 1. Stop accepting new Socket.IO connections and cleanly disconnect existing ones
    try {
        const { getIo } = require('./sockets/auctionEngine');
        const io = getIo();
        if (io) {
            console.log('[SHUTDOWN] Terminating WebSocket connections safely...');
            io.disconnectSockets(true); 
            io.close();
        }
    } catch(e) {}

    // 2. Stop new HTTP traffic and finish active ones
    if (server) {
        server.close(async () => {
            console.log('[SHUTDOWN] HTTP server closed. Cleaning up databases...');
            
                        // 3. Close Redis
            try {
                const redis = redisClient.getRedisClient();
                if (redis) await redis.quit();
                console.log('[SHUTDOWN] Redis connections closed.');
            } catch(e) {}

            // 4. Close MongoDB
            try {
                await mongoose.connection.close(false);
                console.log('[SHUTDOWN] MongoDB connections closed.');
            } catch(e) {}

            console.log('[SHUTDOWN] Exit 0.');
            process.exit(0);
        });

        // Fail-safe timeout
        setTimeout(() => {
            console.error('[SHUTDOWN] Forced exit after 10s timeout.');
            process.exit(1);
        }, 10000).unref();
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection:', reason);
    gracefulShutdown('unhandledRejection');
});

















