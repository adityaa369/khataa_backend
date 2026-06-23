const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const compression = require('compression');

// Load environment variables
dotenv.config();

const app = express();

// Middlewares
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

const path = require('path');
const fs = require('fs');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

app.use((req, res, next) => {
    req.body = req.body || {};
    next();
});

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const safeBody = { ...req.body };
        if (safeBody.otp) safeBody.otp = '****';
        if (safeBody.accessToken) safeBody.accessToken = '****';
        console.log('Body:', JSON.stringify(safeBody));
    }
    next();
});

// Import Routes
const authRoutes = require('./routes/auth');
const loanRoutes = require('./routes/loans');
const creditScoreRoutes = require('./routes/creditScore');
const userRoutes = require('./routes/users');

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/credit-score', creditScoreRoutes);
app.use('/api/users', userRoutes);

// Test Route
app.get('/api/test', (req, res) => res.json({ success: true, message: 'Khaata API is Live' }));

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(`[GLOBAL ERROR] ${req.method} ${req.url}:`, err.message);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
});

// Server Config
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGODB_URI;

// DB Connection & Start Server
const http = require('http');
const initAuctionEngine = require('./sockets/auctionEngine');

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
            console.log(`Mode: Development`);
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
