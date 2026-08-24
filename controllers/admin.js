const Admin = require('../models/Admin');
const jwt = require('jsonwebtoken');
const { cacheSet, cacheGet } = require('../config/redis');
const { logAdminAction } = require('../middleware/adminAuth');
const ReconciliationIncident = require('../models/ReconciliationIncident');
const { getMetricsSnapshot } = require('../middleware/metrics');

exports.login = async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password required' });
        }
        
        const admin = await Admin.findOne({ email });
        if (!admin || !(await admin.comparePassword(password))) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { adminId: admin._id, role: admin.role, mfaVerified: true }, 
            process.env.JWT_SECRET, 
            { expiresIn: '1h' }
        );
        
        res.status(200).json({ success: true, token });
    } catch (err) {
        console.error('[Admin Login Error]', err);
        res.status(500).json({ success: false, message: 'Internal Server Error during login: ' + err.message + ' ' + err.stack });
    }
};
exports.getDashboard = async (req, res) => {
    // 4.12B Operations Dashboard
    const incidents = await ReconciliationIncident.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);
    
    const killSwitch = await cacheGet('FINANCIAL_KILL_SWITCH');

    // Infrastructure Observability
    const mongoose = require('mongoose');
    const { getRedisClient, isRedisAvailable } = require('../config/redis');
    
    // DB Latency check
    const dbStart = process.hrtime.bigint();
    let dbStatus = mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED';
    if (dbStatus === 'CONNECTED') {
        try {
            await mongoose.connection.db.admin().ping();
        } catch(e) {
            dbStatus = 'DISCONNECTED';
        }
    }
    const dbLatency = Number(process.hrtime.bigint() - dbStart) / 1e6;

    // Redis Latency check
    const redisStart = process.hrtime.bigint();
    let redisStatus = isRedisAvailable() ? 'READY' : 'DISCONNECTED';
    if (redisStatus === 'READY') {
        try {
            const client = getRedisClient();
            await client.ping();
        } catch(e) {
            redisStatus = 'DISCONNECTED';
        }
    }
        const redisLatency = Number(process.hrtime.bigint() - redisStart) / 1e6;

    const os = require('os');
    let wsConnections = 'UNKNOWN';
    try {
        const { getIo } = require('../sockets/auctionEngine');
        const io = getIo();
        wsConnections = io && io.engine ? io.engine.clientsCount : 0;
    } catch (e) {
        console.error('[Admin] Failed to fetch WebSocket metrics:', e.message);
    }

    const infrastructure = {
        database: { status: dbStatus, latencyMs: Math.round(dbLatency) },
        redis: { status: redisStatus, latencyMs: Math.round(redisLatency) },
        server: {
            cpuCount: os.cpus().length,
            loadAvg: os.loadavg(),
            memory: process.memoryUsage(),
            uptime: process.uptime(),
            pm2Workers: process.env.instances || 1
        },
        websockets: {
            activeConnections: wsConnections
        }
    };
    res.status(200).json({
        success: true,
        health: getMetricsSnapshot(),
        infrastructure,
        incidents,
        killSwitchEnabled: killSwitch === 'true'
    });
};

exports.getIncidents = async (req, res) => {
    const incidents = await ReconciliationIncident.find().sort({ detectedAt: -1 }).limit(50);
    res.status(200).json({ success: true, incidents });
};

exports.updateIncident = async (req, res) => {
    const { status, resolutionNotes } = req.body;
    if (status === 'RESOLVED' && !resolutionNotes) {
        return res.status(400).json({ success: false, message: 'Resolution notes required to resolve incident' });
    }

    const incident = await ReconciliationIncident.findById(req.params.id);
    if (!incident) return res.status(404).json({ success: false, message: 'Not found' });

    incident.status = status;
    if (resolutionNotes) incident.resolutionNotes = resolutionNotes;
    if (status === 'RESOLVED') {
        incident.resolvedAt = new Date();
        incident.resolvedBy = req.admin._id;
    }

    await incident.save();
    
    await logAdminAction(req.admin._id, 'UPDATE_INCIDENT', `Updated status to ${status}`, 'SUCCESS', req, 'Incident', incident._id.toString());
    
    res.status(200).json({ success: true, incident });
};

exports.toggleKillSwitch = async (req, res) => {
    const { enable, reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Mandatory reason required' });

    await cacheSet('FINANCIAL_KILL_SWITCH', enable ? 'true' : 'false', 86400); // 24h fallback TTL
    
    await logAdminAction(
        req.admin._id, 
        enable ? 'ENABLE_KILL_SWITCH' : 'DISABLE_KILL_SWITCH', 
        reason, 
        'SUCCESS', 
        req
    );

    res.status(200).json({ success: true, killSwitchEnabled: enable });
};
// Append to controllers/admin.js
const Loan = require('../models/Loan');
const LedgerEntry = require('../models/LedgerEntry');

exports.getFinancialOverview = async (req, res) => {
    // F1 - Financial Command Center
    const activeLoans = await Loan.countDocuments({ status: { $in: ['active', 'pending_approval'] } });
    
    const loanStats = await Loan.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: null, totalOutstandingPaise: { $sum: { $subtract: ["$totalPayablePaise", "$paidAmountPaise"] } } } }
    ]);
    const outstanding = loanStats[0]?.totalOutstandingPaise || 0;

    const paymentsToday = await LedgerEntry.aggregate([
        { $match: { type: 'CREDIT', createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } } },
        { $group: { _id: null, totalPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } }
    ]);

    res.status(200).json({
        success: true,
        data: {
            activeLoans,
            outstandingPaise: outstanding,
            paymentsTodayPaise: paymentsToday[0]?.totalPaise || 0,
            paymentsCount: paymentsToday[0]?.count || 0
        }
    });
};

exports.getTransactions = async (req, res) => {
    // F2 - Transaction Explorer (Simplified for simulation)
    const ledger = await LedgerEntry.find().sort({ createdAt: -1 }).limit(100).populate('userId', 'phone firstName lastName');
    res.status(200).json({ success: true, data: ledger });
};

exports.getLoans = async (req, res) => {
    // F5 - Loan Operations
    const loans = await Loan.find().sort({ createdAt: -1 }).limit(100);
    const summary = await Loan.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);
    res.status(200).json({ success: true, data: loans, summary });
};






