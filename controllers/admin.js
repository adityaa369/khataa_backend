const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const os = require('os');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Loan = require('../models/Loan');
const ChitFund = require('../models/ChitFund');
const ChitSubscription = require('../models/ChitSubscription');
const CreditScore = require('../models/CreditScore');
const LedgerEntry = require('../models/LedgerEntry');
const Transaction = require('../models/Transaction');
const TransactionIntent = require('../models/TransactionIntent');
const Notification = require('../models/Notification');
const NotificationOutbox = require('../models/NotificationOutbox');
const MPinCredential = require('../models/MPinCredential');
const DeviceToken = require('../models/DeviceToken');
const Session = require('../models/Session');
const SecurityEvent = require('../models/SecurityEvent');
const ReconciliationIncident = require('../models/ReconciliationIncident');
const FinancialKillSwitch = require('../models/FinancialKillSwitch');
const Otp = require('../models/Otp');
const {
    cacheSet,
    cacheGet,
    getRedisClient,
    isRedisAvailable,
    flushAllCache
} = require('../config/redis');
const { logAdminAction } = require('../middleware/adminAuth');
const {
    getMetricsSnapshot,
    getApiFailures,
    getSlowRequests,
    getRouteMetricsList,
    clearTelemetryHistory
} = require('../middleware/metrics');
const { getKeepAliveStatus, pingNow } = require('../workers/KeepAliveWorker');

function sendError(res, err, status = 500) {
    res.locals.errorMessage = err?.message || 'Internal Server Error';
    res.locals.errorCode = err?.code || err?.name || 'ADMIN_CONTROLLER_ERROR';
    if (err?.stack) {
        res.locals.errorStack = err.stack.split('\n').slice(0, 4).map(s => s.trim()).join(' | ');
    }
    const isProd = process.env.NODE_ENV === 'production';
    return res.status(status).json({
        success: false,
        message: isProd && status === 500 ? 'Internal server error' : err.message
    });
}

// Ensure default operator admin exists if Admin collection is empty
async function ensureDefaultAdmin() {
    try {
        const count = await Admin.countDocuments();
        if (count === 0) {
            const defaultEmail = process.env.ADMIN_EMAIL || 'operator@khatha.app';
            const defaultPassword = process.env.ADMIN_PASSWORD || 'operator123';
            const hash = await bcrypt.hash(defaultPassword, 10);
            await Admin.create({
                email: defaultEmail,
                passwordHash: hash,
                role: 'SUPER_ADMIN',
                mfaEnabled: false,
                isActive: true
            });
            console.log(`[Admin] Initialized default SUPER_ADMIN account: ${defaultEmail}`);
        }
    } catch (e) {
        console.error('[Admin] Failed to initialize default admin:', e.message);
    }
}

// @desc    Admin Control Plane Login
// @route   POST /api/admin/auth/login
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password required' });
        }

        await ensureDefaultAdmin();

        const cleanInput = email.toString().trim().toLowerCase();
        let admin = await Admin.findOne({ email: cleanInput });

        if (admin && (await admin.comparePassword(password))) {
            if (!admin.isActive) {
                return res.status(403).json({ success: false, message: 'Admin account is deactivated' });
            }
            admin.lastLoginAt = new Date();
            await admin.save();

            const token = jwt.sign(
                { adminId: admin._id, role: admin.role, mfaVerified: true },
                process.env.JWT_SECRET,
                { expiresIn: '8h' }
            );
            return res.status(200).json({
                success: true,
                token,
                admin: { email: admin.email, role: admin.role }
            });
        }

        // Fallback: Check if a mobile User with isAdmin === true is logging in via email or phone
        const phoneDigits = cleanInput.replace(/\D/g, '').replace(/^91(\d{10})$/, '$1');
        const adminUser = await User.findOne({
            isAdmin: true,
            $or: [
                { email: cleanInput },
                ...(phoneDigits.length === 10 ? [{ phone: phoneDigits }] : [])
            ]
        }).select('+password');

        if (adminUser && adminUser.password && (await bcrypt.compare(password, adminUser.password))) {
            const token = jwt.sign(
                { id: adminUser.id, adminId: adminUser._id, role: 'SUPER_ADMIN', mfaVerified: true },
                process.env.JWT_SECRET,
                { expiresIn: '8h' }
            );
            return res.status(200).json({
                success: true,
                token,
                admin: { email: adminUser.email || adminUser.phone, role: 'SUPER_ADMIN' }
            });
        }

        return res.status(401).json({ success: false, message: 'Invalid operator credentials' });
    } catch (err) {
        console.error('[Admin Login Error]', err.message);
        return sendError(res, err, 500);
    }
};

// @desc    Operations Dashboard Snapshot (Unified V1 + V2 + Live Platform & Ledger Metrics)
// @route   GET /api/admin/dashboard
exports.getDashboard = async (req, res) => {
    try {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const [
            incidents,
            registeredUsers,
            activeCredits,
            totalLoans,
            activeLoanDocs,
            txToday,
            ledgerToday
        ] = await Promise.all([
            ReconciliationIncident.aggregate([
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ]),
            User.countDocuments(),
            Loan.countDocuments({ status: 'active' }),
            Loan.countDocuments(),
            Loan.find({ status: 'active' })
                .select('amount amountPaise totalPayable totalPayablePaise paidAmount paidAmountPaise principalOutstandingPaise interestOutstandingPaise')
                .lean(),
            Transaction.aggregate([
                { $match: { type: 'PAYMENT', createdAt: { $gte: startOfToday } } },
                { $group: { _id: null, totalPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } }
            ]),
            LedgerEntry.aggregate([
                { $match: { type: 'CREDIT', createdAt: { $gte: startOfToday } } },
                { $group: { _id: null, totalPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } }
            ])
        ]);

        let outstandingPaise = 0;
        activeLoanDocs.forEach(l => {
            if (typeof l.principalOutstandingPaise === 'number') {
                outstandingPaise += Math.max(0, l.principalOutstandingPaise + (l.interestOutstandingPaise || 0));
            } else if (typeof l.totalPayablePaise === 'number') {
                outstandingPaise += Math.max(0, l.totalPayablePaise - (l.paidAmountPaise || 0));
            } else {
                const totalPayableR = l.totalPayable || l.amount || 0;
                const paidR = l.paidAmount || 0;
                outstandingPaise += Math.max(0, Math.round((totalPayableR - paidR) * 100));
            }
        });

        const paymentsTodayPaise = txToday[0]?.totalPaise || ledgerToday[0]?.totalPaise || 0;
        const paymentsCount = txToday[0]?.count || ledgerToday[0]?.count || 0;

        const openIncidentsCount = incidents
            .filter(i => i._id !== 'RESOLVED')
            .reduce((acc, cur) => acc + (cur.count || 0), 0);

        let killSwitchEnabled = false;
        const cachedKs = await cacheGet('FINANCIAL_KILL_SWITCH');
        if (cachedKs !== null) {
            killSwitchEnabled = cachedKs === 'true';
        } else {
            const ksDoc = await FinancialKillSwitch.findOne({ key: 'FINANCIAL' }).lean();
            killSwitchEnabled = Boolean(ksDoc && ksDoc.enabled);
        }

        // DB Latency check
        const dbStart = process.hrtime.bigint();
        let dbStatus = mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED';
        if (dbStatus === 'CONNECTED') {
            try {
                await mongoose.connection.db.admin().ping();
            } catch {
                dbStatus = 'DISCONNECTED';
            }
        }
        const dbLatency = Math.max(1, Math.round(Number(process.hrtime.bigint() - dbStart) / 1e6));

        // Redis / Cache Latency check (graceful fallback when REDIS_URL is not configured)
        const redisStart = process.hrtime.bigint();
        let redisMode = isRedisAvailable() ? 'READY' : 'IN_MEMORY_FALLBACK';
        if (redisMode === 'READY') {
            try {
                const client = getRedisClient();
                await client.ping();
            } catch {
                redisMode = 'IN_MEMORY_FALLBACK';
            }
        }
        const redisLatency = Math.max(1, Math.round(Number(process.hrtime.bigint() - redisStart) / 1e6));

        let wsConnections = 0;
        try {
            const auctionModule = require('../sockets/auctionEngine');
            if (typeof auctionModule.getIo === 'function') {
                const io = auctionModule.getIo();
                wsConnections = io && io.engine ? io.engine.clientsCount : 0;
            }
        } catch {
            wsConnections = 0;
        }

        const keepAlive = getKeepAliveStatus();
        const healthSnapshot = getMetricsSnapshot();

        const infrastructure = {
            database: { status: dbStatus, latencyMs: dbLatency },
            redis: { status: 'READY', mode: redisMode, latencyMs: redisLatency },
            server: {
                cpuCount: os.cpus().length,
                loadAvg: os.loadavg(),
                memory: process.memoryUsage(),
                uptime: Math.round(process.uptime()),
                pm2Workers: Number(process.env.instances || 1)
            },
            websockets: {
                activeConnections: wsConnections
            },
            keepAlive
        };

        const platform = {
            registeredUsers,
            totalUsers: registeredUsers,
            activeCredits,
            activeLoans: activeCredits,
            totalLoans,
            outstandingPaise,
            activeOutstandingBalancePaise: outstandingPaise,
            outstandingRupees: Math.round(outstandingPaise / 100),
            paymentsTodayPaise,
            repaymentsTodayPaise: paymentsTodayPaise,
            repaymentsTodayRupees: Math.round(paymentsTodayPaise / 100),
            paymentsCount,
            ledgerReconciliation: openIncidentsCount === 0 ? 'BALANCED' : 'ATTENTION_REQUIRED',
            ledgerBalanced: openIncidentsCount === 0,
            openIncidents: openIncidentsCount,
            dbLatencyMs: dbLatency,
            killSwitchEnabled
        };

        res.status(200).json({
            success: true,
            status: dbStatus === 'CONNECTED' ? 'ONLINE' : 'DEGRADED',
            apiStatus: 'ONLINE',
            mongoStatus: dbStatus === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
            lastVerifiedAt: new Date().toISOString(),
            health: healthSnapshot,
            infrastructure,
            platform,
            metrics: platform,
            data: {
                ...platform,
                health: healthSnapshot,
                infrastructure,
                incidents,
                killSwitchEnabled
            },
            registeredUsers,
            totalUsers: registeredUsers,
            activeCredits,
            activeLoans: activeCredits,
            outstandingPaise,
            activeOutstandingBalancePaise: outstandingPaise,
            paymentsTodayPaise,
            repaymentsTodayPaise: paymentsTodayPaise,
            paymentsCount,
            ledgerReconciliation: platform.ledgerReconciliation,
            ledgerBalanced: platform.ledgerBalanced,
            openIncidents: openIncidentsCount,
            dbLatencyMs: dbLatency,
            incidents,
            killSwitchEnabled
        });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Observability Dashboard 1: App Latency, Bottlenecks & User-Facing Issues
// @route   GET /api/admin/observability/latency-errors
exports.getLatencyAndUserIssues = async (req, res) => {
    try {
        const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [
            stuckIntents,
            failedIntentsCount,
            failedOutbox,
            pendingOutboxCount,
            unverifiedUsersCount,
            suspendedUsersCount,
            openIncidentsCount,
            recentUserErrors
        ] = await Promise.all([
            TransactionIntent.find({
                $or: [
                    { status: 'PENDING', createdAt: { $lte: fiveMinsAgo } },
                    { status: 'FAILED', createdAt: { $gte: twentyFourHoursAgo } }
                ]
            }).sort({ createdAt: -1 }).limit(25).lean().catch(() => []),
            TransactionIntent.countDocuments({ status: 'FAILED' }).catch(() => 0),
            NotificationOutbox.find({
                status: { $in: ['FAILED', 'DEAD_LETTER'] }
            }).sort({ updatedAt: -1 }).limit(25).lean().catch(() => []),
            NotificationOutbox.countDocuments({ status: 'PENDING' }).catch(() => 0),
            User.countDocuments({ isEmailVerified: false }),
            User.countDocuments({ isSuspended: true }),
            ReconciliationIncident.countDocuments({ status: { $ne: 'RESOLVED' } }),
            SecurityEvent.find({
                actorType: 'USER',
                result: { $in: ['FAILED', 'BLOCKED'] }
            }).sort({ createdAt: -1 }).limit(30).lean().catch(() => [])
        ]);

        const health = getMetricsSnapshot();
        const slowRequests = getSlowRequests(50);
        const routeBreakdown = getRouteMetricsList();
        const keepAlive = getKeepAliveStatus();

        res.status(200).json({
            success: true,
            timestamp: new Date().toISOString(),
            data: {
                latency: {
                    p50Ms: health.latency.p50,
                    p95Ms: health.latency.p95,
                    p99Ms: health.latency.p99,
                    activeRequests: health.activeRequests,
                    totalRequests: health.totalRequests || 0,
                    totalErrors5xx: health.errors5xx || 0,
                    totalErrors4xx: health.errors4xx || 0,
                    uptimeSeconds: health.uptimeSeconds || Math.round(process.uptime())
                },
                slowRequests,
                routeBreakdown,
                userFacingIssues: {
                    stuckOrFailedIntentsCount: stuckIntents.length,
                    totalFailedIntents: failedIntentsCount,
                    stuckIntents,
                    failedNotificationsCount: failedOutbox.length,
                    pendingNotificationsCount: pendingOutboxCount,
                    failedNotifications: failedOutbox,
                    unverifiedUsersCount,
                    suspendedUsersCount,
                    openReconciliationIncidents: openIncidentsCount,
                    recentUserFrictionEvents: recentUserErrors
                },
                keepAlive
            }
        });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Observability Dashboard 2: API Failures, 5xx/4xx Traces & Root-Cause Explorer
// @route   GET /api/admin/observability/api-failures
exports.getApiFailuresDashboard = async (req, res) => {
    try {
        const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
        const liveFailures = getApiFailures(limit);
        const routeBreakdown = getRouteMetricsList();
        const health = getMetricsSnapshot();

        const persistedFailureEvents = await SecurityEvent.find({
            $or: [
                { eventType: 'API_5XX_SPIKE' },
                { result: { $in: ['FAILED', 'BLOCKED'] } }
            ]
        })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        const enrichedPersisted = persistedFailureEvents.map(ev => {
            const isLegacyAnonymousSpike =
                ev.eventType === 'API_5XX_SPIKE' &&
                (!ev.route || ev.route === 'N/A') &&
                (!ev.metadata || Object.keys(ev.metadata).length === 0);

            return {
                eventId: ev.eventId || String(ev._id),
                timestamp: ev.createdAt,
                eventType: ev.eventType,
                severity: ev.severity,
                actorType: ev.actorType || 'ANONYMOUS',
                actorId: ev.actorId || 'Anonymous',
                route: isLegacyAnonymousSpike
                    ? '/api/admin/dashboard (Legacy pre-fix Redis helper crash)'
                    : (ev.route || ev.metadata?.route || 'N/A'),
                ipReference: ev.ipReference || 'N/A',
                result: ev.result,
                financialImpact: ev.financialImpact || 'NONE',
                requestId: ev.requestId || 'N/A',
                rootCause: isLegacyAnonymousSpike
                    ? 'Resolved: config/redis.js was missing isRedisAvailable() export in commit e343f1f'
                    : (ev.metadata?.errorMessage || ev.metadata?.reason || ev.metadata?.action || 'Recorded by security telemetry'),
                statusCode: ev.metadata?.statusCode || (ev.eventType === 'API_5XX_SPIKE' ? 500 : 400),
                durationMs: ev.metadata?.durationMs || null,
                stackSummary: ev.metadata?.stackSummary || null,
                isLegacyResolved: isLegacyAnonymousSpike
            };
        });

        const failingRoutes = routeBreakdown.filter(r => r.errors5xx > 0 || r.errors4xx > 0);

        res.status(200).json({
            success: true,
            timestamp: new Date().toISOString(),
            data: {
                summary: {
                    total5xx: health.errors5xx || 0,
                    total4xx: health.errors4xx || 0,
                    liveFailureTracesCount: liveFailures.length,
                    persistedEventsCount: enrichedPersisted.length,
                    legacyResolvedSpikesCount: enrichedPersisted.filter(e => e.isLegacyResolved).length,
                    failingRoutesCount: failingRoutes.length
                },
                failingRoutes,
                liveFailures,
                persistedEvents: enrichedPersisted
            }
        });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Clear stale anonymous 5xx telemetry spikes & reset in-memory counters
// @route   POST /api/admin/observability/clear-telemetry
exports.clearStaleTelemetry = async (req, res) => {
    try {
        const mode = req.body.mode || 'STALE_5XX_ONLY'; // 'STALE_5XX_ONLY' | 'ALL_SECURITY_EVENTS'
        let dbResult = { deletedCount: 0 };

        if (mode === 'ALL_SECURITY_EVENTS') {
            dbResult = await SecurityEvent.deleteMany({});
        } else {
            dbResult = await SecurityEvent.deleteMany({
                eventType: 'API_5XX_SPIKE'
            });
        }

        clearTelemetryHistory();

        if (req.admin) {
            await logAdminAction(
                req.admin._id,
                'CLEAR_TELEMETRY_SPIKES',
                `Cleared ${dbResult.deletedCount} telemetry events (${mode}) and reset in-memory failure buffers`,
                'SUCCESS',
                req
            );
        }

        res.status(200).json({
            success: true,
            deletedCount: dbResult.deletedCount,
            message: `Cleared ${dbResult.deletedCount} telemetry events and reset live failure counters.`
        });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Trigger immediate keep-alive health check probe
// @route   POST /api/admin/observability/keep-alive/ping
exports.triggerKeepAlivePing = async (req, res) => {
    try {
        const status = await pingNow('manual-admin-trigger');
        res.status(200).json({ success: true, data: status });
    } catch (err) {
        sendError(res, err);
    }
};

// ─── Live User Data Query & Purge Studio (Preserves Schema & Indexes) ───────

const MANAGED_COLLECTIONS = {
    users: { model: User, label: 'Users (Mobile Accounts)', category: 'USER_DATA', protected: false },
    loans: { model: Loan, label: 'Loans / Credit Agreements', category: 'FINANCIAL_DATA', protected: false },
    chitfunds: { model: ChitFund, label: 'Chit Funds', category: 'FINANCIAL_DATA', protected: false },
    chitsubscriptions: { model: ChitSubscription, label: 'Chit Subscriptions', category: 'FINANCIAL_DATA', protected: false },
    transactions: { model: Transaction, label: 'Transactions', category: 'FINANCIAL_DATA', protected: false },
    ledgerentries: { model: LedgerEntry, label: 'Ledger Entries', category: 'FINANCIAL_DATA', protected: false },
    transactionintents: { model: TransactionIntent, label: 'Transaction Intents (Idempotency)', category: 'FINANCIAL_DATA', protected: false },
    creditscores: { model: CreditScore, label: 'Credit Scores / Trust Scores', category: 'USER_DATA', protected: false },
    notifications: { model: Notification, label: 'User Notifications', category: 'USER_DATA', protected: false },
    notificationoutboxes: { model: NotificationOutbox, label: 'Notification Outbox Queue', category: 'SYSTEM_QUEUE', protected: false },
    mpincredentials: { model: MPinCredential, label: 'User MPIN Credentials', category: 'USER_DATA', protected: false },
    devicetokens: { model: DeviceToken, label: 'FCM Device Tokens', category: 'USER_DATA', protected: false },
    sessions: { model: Session, label: 'User Sessions', category: 'USER_DATA', protected: false },
    otps: { model: Otp, label: 'Temporary OTP Records', category: 'USER_DATA', protected: false },
    reconciliationincidents: { model: ReconciliationIncident, label: 'Reconciliation Incidents', category: 'TELEMETRY_DATA', protected: false },
    securityevents: { model: SecurityEvent, label: 'Security Telemetry Events', category: 'TELEMETRY_DATA', protected: false },
    admins: { model: Admin, label: 'Admin Control Plane Operators', category: 'CONTROL_PLANE', protected: true },
    financialkillswitches: { model: FinancialKillSwitch, label: 'Financial Kill Switch Config', category: 'CONTROL_PLANE', protected: true }
};

function sanitizeMongoFilter(rawFilter = {}) {
    if (!rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) {
        return {};
    }
    const forbiddenKeys = new Set(['$where', '$function', '$accumulator', '$expr']);
    const clean = {};
    for (const [k, v] of Object.entries(rawFilter)) {
        if (forbiddenKeys.has(k)) continue;
        if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) {
            clean[k] = sanitizeMongoFilter(v);
        } else {
            clean[k] = v;
        }
    }
    return clean;
}

function buildSmartFilter(collectionKey, body = {}) {
    const filter = sanitizeMongoFilter(body.filter || {});
    const search = (body.search || '').trim();
    const phone = (body.phone || '').trim();
    const email = (body.email || '').trim().toLowerCase();
    const userId = (body.userId || '').trim();
    const status = (body.status || '').trim();

    if (collectionKey === 'users') {
        if (phone) filter.phone = { $regex: phone.replace(/\D/g, ''), $options: 'i' };
        if (email) filter.email = email;
        if (userId) {
            if (mongoose.Types.ObjectId.isValid(userId)) {
                filter.$or = [{ id: userId }, { _id: userId }];
            } else {
                filter.id = userId;
            }
        }
        if (search && !phone && !email && !userId) {
            filter.$or = [
                { phone: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } },
                { id: search }
            ];
        }
    } else if (collectionKey === 'loans') {
        if (status && status !== 'ALL') filter.status = status;
        if (phone) filter.borrowerPhone = { $regex: phone.replace(/\D/g, ''), $options: 'i' };
        if (userId) filter.$or = [{ lender: userId }, { borrower: userId }];
        if (search && !phone && !userId) {
            filter.$or = [
                { borrowerName: { $regex: search, $options: 'i' } },
                { borrowerPhone: { $regex: search, $options: 'i' } },
                { lender: search },
                { borrower: search }
            ];
        }
    } else if (collectionKey === 'securityevents') {
        if (status && status !== 'ALL') filter.eventType = status;
        if (userId) filter.actorId = userId;
        if (search && !userId) {
            filter.$or = [
                { eventType: { $regex: search, $options: 'i' } },
                { actorId: { $regex: search, $options: 'i' } },
                { route: { $regex: search, $options: 'i' } }
            ];
        }
    } else {
        if (status && status !== 'ALL') filter.status = status;
        if (userId) {
            filter.$or = [
                { user: userId },
                { userId: userId },
                { actorId: userId },
                { owner: userId },
                { account: userId }
            ];
        }
    }

    return filter;
}

// @desc    Get all database collections with live document counts & schema/index status
// @route   GET /api/admin/data/collections
exports.getDatabaseCollections = async (req, res) => {
    try {
        const entries = await Promise.all(
            Object.entries(MANAGED_COLLECTIONS).map(async ([key, cfg]) => {
                let documentCount = 0;
                let indexCount = 0;
                let schemaFields = [];
                try {
                    documentCount = await cfg.model.countDocuments();
                    const indexes = await cfg.model.collection.indexes().catch(() => []);
                    indexCount = Array.isArray(indexes) ? indexes.length : 1;
                    schemaFields = Object.keys(cfg.model.schema.paths)
                        .filter(p => !p.startsWith('__') && p !== 'password' && p !== 'passwordHash')
                        .slice(0, 12);
                } catch {
                    documentCount = 0;
                }
                return {
                    key,
                    collectionName: cfg.model.collection.collectionName,
                    label: cfg.label,
                    category: cfg.category,
                    protected: cfg.protected,
                    documentCount,
                    indexCount,
                    schemaPreserved: true,
                    schemaFields
                };
            })
        );

        const totalUserDocs = entries
            .filter(e => !e.protected)
            .reduce((sum, e) => sum + e.documentCount, 0);

        res.status(200).json({
            success: true,
            totalUserDocuments: totalUserDocs,
            collections: entries
        });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Preview documents matching a query before deleting user data
// @route   POST /api/admin/data/query-preview
exports.previewDataQuery = async (req, res) => {
    try {
        const target = (req.body.target || 'users').toLowerCase().trim();
        const cfg = MANAGED_COLLECTIONS[target];
        if (!cfg) {
            return res.status(400).json({
                success: false,
                message: `Unknown target collection: ${target}`
            });
        }

        const filter = buildSmartFilter(target, req.body);
        const limit = Math.min(50, parseInt(req.body.limit, 10) || 20);

        const [matchingCount, sampleDocs] = await Promise.all([
            cfg.model.countDocuments(filter),
            cfg.model
                .find(filter)
                .select('-password -passwordHash -mpinHash -emailVerificationToken -pan -aadhar')
                .sort({ createdAt: -1, _id: -1 })
                .limit(limit)
                .lean()
        ]);

        res.status(200).json({
            success: true,
            target,
            label: cfg.label,
            protected: cfg.protected,
            appliedFilter: filter,
            matchingCount,
            sampleDocs
        });
    } catch (err) {
        sendError(res, err);
    }
};

// Helper to cascade delete a single user's data across all collections while keeping schemas intact
async function deleteSingleUserCascade(userDoc, options = {}) {
    const uid = userDoc.id || String(userDoc._id);
    const mongoId = userDoc._id;
    const phone = userDoc.phone;

    const userLoanDocs = await Loan.find({
        $or: [
            { lender: uid },
            { borrower: uid },
            ...(phone ? [{ borrowerPhone: phone }] : [])
        ]
    }).select('_id').lean();
    const loanIds = userLoanDocs.map(l => l._id);

    const [
        loansRes,
        txRes,
        ledgerRes,
        intentsRes,
        chitsRes,
        chitSubsRes,
        creditScoreRes,
        notifRes,
        outboxRes,
        mpinRes,
        deviceTokenRes,
        sessionRes,
        secRes,
        otpRes,
        userRes
    ] = await Promise.all([
        Loan.deleteMany({ _id: { $in: loanIds } }),
        Transaction.deleteMany({
            $or: [
                { actorId: uid },
                ...(loanIds.length > 0 ? [{ loanId: { $in: loanIds } }] : [])
            ]
        }),
        LedgerEntry.deleteMany({
            $or: [
                { account: uid },
                { account: `USER_${uid}` },
                ...(loanIds.length > 0 ? [{ referenceId: { $in: loanIds } }] : [])
            ]
        }),
        TransactionIntent.deleteMany({
            $or: [
                { actorId: uid },
                ...(loanIds.length > 0 ? [{ loanId: { $in: loanIds } }] : [])
            ]
        }).catch(() => ({ deletedCount: 0 })),
        ChitFund.deleteMany({ owner: uid }),
        ChitSubscription.deleteMany({ user: mongoId }).catch(() => ({ deletedCount: 0 })),
        CreditScore.deleteMany({ user: uid }),
        Notification.deleteMany({ user: uid }).catch(() => ({ deletedCount: 0 })),
        NotificationOutbox.deleteMany({ recipientId: uid }).catch(() => ({ deletedCount: 0 })),
        MPinCredential.deleteMany({ userId: mongoId }).catch(() => ({ deletedCount: 0 })),
        DeviceToken.deleteMany({ userId: mongoId }).catch(() => ({ deletedCount: 0 })),
        Session.deleteMany({ userId: mongoId }).catch(() => ({ deletedCount: 0 })),
        SecurityEvent.deleteMany({
            $or: [{ actorId: uid }, { userId: mongoId }]
        }).catch(() => ({ deletedCount: 0 })),
        phone ? Otp.deleteMany({ phone }).catch(() => ({ deletedCount: 0 })) : Promise.resolve({ deletedCount: 0 }),
        User.deleteOne({ _id: mongoId })
    ]);

    // Also remove from Firebase Auth if requested and configured
    if (options.removeFirebaseAuth !== false && userDoc.firebaseUid) {
        try {
            const firebaseAdmin = require('firebase-admin');
            if (firebaseAdmin.apps && firebaseAdmin.apps.length > 0) {
                await firebaseAdmin.auth().deleteUser(userDoc.firebaseUid);
            }
        } catch {
            // Ignore if Firebase UID does not exist
        }
    }

    return {
        users: userRes.deletedCount || 0,
        loans: loansRes.deletedCount || 0,
        transactions: txRes.deletedCount || 0,
        ledgerEntries: ledgerRes.deletedCount || 0,
        transactionIntents: intentsRes.deletedCount || 0,
        chitFunds: chitsRes.deletedCount || 0,
        chitSubscriptions: chitSubsRes.deletedCount || 0,
        creditScores: creditScoreRes.deletedCount || 0,
        notifications: notifRes.deletedCount || 0,
        notificationOutbox: outboxRes.deletedCount || 0,
        mpinCredentials: mpinRes.deletedCount || 0,
        deviceTokens: deviceTokenRes.deletedCount || 0,
        sessions: sessionRes.deletedCount || 0,
        securityEvents: secRes.deletedCount || 0,
        otps: otpRes.deletedCount || 0
    };
}

// @desc    Delete user data by query, user cascade, or full user-data purge (preserving schema, indexes & admins)
// @route   POST /api/admin/data/purge
exports.purgeUserData = async (req, res) => {
    try {
        const {
            mode = 'QUERY_DELETE', // 'QUERY_DELETE' | 'USER_CASCADE' | 'PURGE_ALL_USER_DATA'
            target = 'users',
            reason = 'Operator requested user data deletion via Control Plane',
            includeSecurityTelemetry = false
        } = req.body;

        if (!reason || String(reason).trim().length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a brief audit reason for deleting user data.'
            });
        }

        let summary = {};
        let totalDeleted = 0;

        if (mode === 'USER_CASCADE') {
            const filter = buildSmartFilter('users', req.body);
            if (Object.keys(filter).length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'USER_CASCADE requires userId, phone, email, or search filter.'
                });
            }

            const matchedUsers = await User.find(filter).select('_id id phone email firebaseUid').lean();
            if (matchedUsers.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No matching users found for cascade deletion.'
                });
            }

            const aggregateCounts = {};
            for (const u of matchedUsers) {
                const counts = await deleteSingleUserCascade(u);
                for (const [k, v] of Object.entries(counts)) {
                    aggregateCounts[k] = (aggregateCounts[k] || 0) + v;
                    totalDeleted += v;
                }
            }
            summary = aggregateCounts;
        } else if (mode === 'PURGE_ALL_USER_DATA') {
            // Delete all user & financial records while strictly preserving schemas, indexes, and Admin accounts
            const targetsToPurge = [
                ['users', User],
                ['loans', Loan],
                ['chitfunds', ChitFund],
                ['chitsubscriptions', ChitSubscription],
                ['transactions', Transaction],
                ['ledgerentries', LedgerEntry],
                ['transactionintents', TransactionIntent],
                ['creditscores', CreditScore],
                ['notifications', Notification],
                ['notificationoutboxes', NotificationOutbox],
                ['mpincredentials', MPinCredential],
                ['devicetokens', DeviceToken],
                ['sessions', Session],
                ['otps', Otp],
                ['reconciliationincidents', ReconciliationIncident]
            ];

            if (includeSecurityTelemetry) {
                targetsToPurge.push(['securityevents', SecurityEvent]);
            }

            const results = await Promise.all(
                targetsToPurge.map(async ([key, model]) => {
                    const resDel = await model.deleteMany({}).catch(() => ({ deletedCount: 0 }));
                    return [key, resDel.deletedCount || 0];
                })
            );

            for (const [key, count] of results) {
                summary[key] = count;
                totalDeleted += count;
            }
        } else {
            // mode === 'QUERY_DELETE'
            const targetKey = String(target).toLowerCase().trim();
            const cfg = MANAGED_COLLECTIONS[targetKey];
            if (!cfg) {
                return res.status(400).json({
                    success: false,
                    message: `Unknown target collection: ${targetKey}`
                });
            }
            if (cfg.protected) {
                return res.status(403).json({
                    success: false,
                    message: `Collection '${targetKey}' is protected (Control Plane configuration/operators cannot be purged).`
                });
            }

            const filter = buildSmartFilter(targetKey, req.body);
            const allowEmptyFilter = Boolean(req.body.allowEmptyFilter);
            if (Object.keys(filter).length === 0 && !allowEmptyFilter) {
                return res.status(400).json({
                    success: false,
                    message: 'Query filter is empty. Specify a filter (phone, email, userId, status, or query) or set allowEmptyFilter: true to clear the entire collection.'
                });
            }

            if (targetKey === 'users' && req.body.cascade !== false) {
                const matchedUsers = await User.find(filter).select('_id id phone email firebaseUid').lean();
                const aggregateCounts = {};
                for (const u of matchedUsers) {
                    const counts = await deleteSingleUserCascade(u);
                    for (const [k, v] of Object.entries(counts)) {
                        aggregateCounts[k] = (aggregateCounts[k] || 0) + v;
                        totalDeleted += v;
                    }
                }
                summary = aggregateCounts;
            } else {
                const delResult = await cfg.model.deleteMany(filter);
                summary[targetKey] = delResult.deletedCount || 0;
                totalDeleted = delResult.deletedCount || 0;
            }
        }

        // Flush Redis & In-Memory caches immediately so changes reflect with ZERO server reload
        await flushAllCache();

        if (req.admin) {
            await logAdminAction(
                req.admin._id,
                `DATA_PURGE_${mode}`,
                `${reason} (Deleted ${totalDeleted} records; schemas & indexes preserved)`,
                'SUCCESS',
                req,
                'Database',
                target
            );
        }

        res.status(200).json({
            success: true,
            mode,
            totalDeleted,
            schemasAndIndexesPreserved: true,
            cacheFlushed: true,
            serverReloadRequired: false,
            summary,
            timestamp: new Date().toISOString(),
            message: `Successfully deleted ${totalDeleted} document(s) across user collections without reloading the server. All schemas, indexes, and Admin accounts remain intact.`
        });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Delete a single user and cascade all their data immediately
// @route   DELETE /api/admin/users/:id & DELETE /api/admin/customers/:id
exports.deleteUserAdmin = async (req, res) => {
    try {
        const paramId = req.params.id;
        const reason = req.body?.reason || req.query?.reason || 'Admin deleted user data from Control Plane';
        const query = mongoose.Types.ObjectId.isValid(paramId)
            ? { $or: [{ id: paramId }, { _id: paramId }] }
            : { id: paramId };

        const user = await User.findOne(query).select('_id id phone email firstName lastName firebaseUid').lean();
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const deletedBreakdown = await deleteSingleUserCascade(user);
        const totalDeleted = Object.values(deletedBreakdown).reduce((a, b) => a + b, 0);

        await flushAllCache();

        if (req.admin) {
            await logAdminAction(
                req.admin._id,
                'USER_DATA_DELETED',
                `${reason} (User: ${user.phone || user.email || user.id}, Total records removed: ${totalDeleted})`,
                'SUCCESS',
                req,
                'User',
                user.id || String(user._id)
            );
        }

        res.status(200).json({
            success: true,
            userId: user.id || String(user._id),
            totalDeleted,
            deletedBreakdown,
            schemasAndIndexesPreserved: true,
            serverReloadRequired: false,
            message: `User ${user.firstName || user.phone || user.id} and ${totalDeleted} associated records deleted immediately.`
        });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Get reconciliation incidents
// @route   GET /api/admin/incidents
exports.getIncidents = async (req, res) => {
    try {
        const incidents = await ReconciliationIncident.find().sort({ detectedAt: -1 }).limit(50);
        res.status(200).json({ success: true, incidents });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Update reconciliation incident status
// @route   PUT /api/admin/incidents/:id/status
exports.updateIncident = async (req, res) => {
    try {
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
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Toggle kill switch (simple endpoint)
// @route   POST /api/admin/kill-switch/toggle
exports.toggleKillSwitch = async (req, res) => {
    try {
        const { enable, reason } = req.body;
        if (!reason) return res.status(400).json({ success: false, message: 'Mandatory reason required' });

        await cacheSet('FINANCIAL_KILL_SWITCH', enable ? 'true' : 'false', 86400);
        await FinancialKillSwitch.findOneAndUpdate(
            { key: 'FINANCIAL' },
            {
                $set: {
                    enabled: Boolean(enable),
                    reason: reason.trim(),
                    updatedBy: req.admin._id,
                    ...(enable ? { activatedBy: req.admin._id, activatedAt: new Date() } : {})
                }
            },
            { upsert: true, new: true }
        );

        await logAdminAction(
            req.admin._id,
            enable ? 'ENABLE_KILL_SWITCH' : 'DISABLE_KILL_SWITCH',
            reason,
            'SUCCESS',
            req
        );

        res.status(200).json({ success: true, killSwitchEnabled: Boolean(enable) });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Financial Overview (supports both V2 Paise & V1 Rupees seamlessly)
// @route   GET /api/admin/financial/overview
exports.getFinancialOverview = async (req, res) => {
    try {
        const [activeLoans, totalLoans, completedLoans, pendingLoans] = await Promise.all([
            Loan.countDocuments({ status: 'active' }),
            Loan.countDocuments(),
            Loan.countDocuments({ status: 'completed' }),
            Loan.countDocuments({ status: 'pending_approval' })
        ]);

        const activeLoanDocs = await Loan.find({ status: 'active' })
            .select('amount amountPaise totalPayable totalPayablePaise paidAmount paidAmountPaise principalOutstandingPaise interestOutstandingPaise')
            .lean();

        let outstandingPaise = 0;
        activeLoanDocs.forEach(l => {
            if (typeof l.principalOutstandingPaise === 'number') {
                outstandingPaise += Math.max(0, l.principalOutstandingPaise + (l.interestOutstandingPaise || 0));
            } else if (typeof l.totalPayablePaise === 'number') {
                outstandingPaise += Math.max(0, l.totalPayablePaise - (l.paidAmountPaise || 0));
            } else {
                const totalPayableR = l.totalPayable || l.amount || 0;
                const paidR = l.paidAmount || 0;
                outstandingPaise += Math.max(0, Math.round((totalPayableR - paidR) * 100));
            }
        });

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const [txToday, ledgerToday] = await Promise.all([
            Transaction.aggregate([
                { $match: { type: 'PAYMENT', createdAt: { $gte: startOfToday } } },
                { $group: { _id: null, totalPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } }
            ]),
            LedgerEntry.aggregate([
                { $match: { type: 'CREDIT', createdAt: { $gte: startOfToday } } },
                { $group: { _id: null, totalPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } }
            ])
        ]);

        const paymentsTodayPaise = txToday[0]?.totalPaise || ledgerToday[0]?.totalPaise || 0;
        const paymentsCount = txToday[0]?.count || ledgerToday[0]?.count || 0;

        res.status(200).json({
            success: true,
            data: {
                activeLoans,
                totalLoans,
                completedLoans,
                pendingLoans,
                outstandingPaise,
                paymentsTodayPaise,
                paymentsCount
            }
        });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Get live transactions & repayments list
// @route   GET /api/admin/financial/transactions
exports.getTransactions = async (req, res) => {
    try {
        const [transactions, ledgerEntries] = await Promise.all([
            Transaction.find()
                .sort({ createdAt: -1 })
                .limit(100)
                .populate('loanId', 'borrowerName borrowerPhone loanType status amount amountPaise')
                .lean(),
            LedgerEntry.find()
                .sort({ createdAt: -1 })
                .limit(100)
                .lean()
        ]);

        // Normalize unified transaction stream for the admin explorer
        const formatted = transactions.length > 0
            ? transactions.map(t => ({
                id: t.transactionId || t._id.toString(),
                type: t.type,
                amountPaise: t.amountPaise || 0,
                actorId: t.actorId,
                loanId: t.loanId?._id ? t.loanId._id.toString() : (t.loanId ? String(t.loanId) : null),
                borrowerName: t.loanId?.borrowerName || 'Counterparty',
                loanType: t.loanId?.loanType || 'credit',
                intentId: t.intentId || null,
                createdAt: t.createdAt || t.effectiveAt
            }))
            : ledgerEntries.map(e => ({
                id: e.transactionId || e._id.toString(),
                type: e.type,
                amountPaise: e.amountPaise || 0,
                actorId: e.account,
                loanId: e.referenceId ? e.referenceId.toString() : null,
                borrowerName: e.description || e.account,
                loanType: e.referenceModel || 'Loan',
                intentId: e.idempotencyKey || null,
                createdAt: e.createdAt
            }));

        res.status(200).json({ success: true, data: formatted });
    } catch (err) {
        sendError(res, err);
    }
};

// @desc    Get all loans / credits (supports both V1 /loans and V2 /financial/loans/list)
// @route   GET /api/admin/loans & GET /api/admin/financial/loans/list
exports.getLoans = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 50;
        const filter = {};
        if (req.query.status && req.query.status !== 'ALL') filter.status = req.query.status;
        if (req.query.type && req.query.type !== 'ALL') filter.loanType = req.query.type;

        const [loans, total, summaryAgg] = await Promise.all([
            Loan.find(filter).skip((page - 1) * limit).limit(limit).sort({ createdAt: -1 }).lean(),
            Loan.countDocuments(filter),
            Loan.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
        ]);

        // Enrich lender names from User collection by User.id
        const lenderIds = [...new Set(loans.map(l => l.lender).filter(Boolean))];
        const lenders = await User.find({ id: { $in: lenderIds } }).select('id firstName lastName phone').lean();
        const lenderMap = {};
        lenders.forEach(u => {
            lenderMap[u.id] = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.phone;
        });

        const enrichedLoans = loans.map(l => {
            const amountPaise = typeof l.amountPaise === 'number' ? l.amountPaise : Math.round((l.amount || 0) * 100);
            const paidAmountPaise = typeof l.paidAmountPaise === 'number' ? l.paidAmountPaise : Math.round((l.paidAmount || 0) * 100);
            const totalPayablePaise = typeof l.totalPayablePaise === 'number' ? l.totalPayablePaise : Math.round((l.totalPayable || l.amount || 0) * 100);
            return {
                ...l,
                lenderName: lenderMap[l.lender] || l.lender,
                amountPaise,
                paidAmountPaise,
                totalPayablePaise,
                outstandingPaise: Math.max(0, totalPayablePaise - paidAmountPaise),
                documentCount: Array.isArray(l.documentIds) && l.documentIds.length > 0
                    ? l.documentIds.length
                    : (l.documentId ? l.documentId.split(',').filter(Boolean).length : 0)
            };
        });

        res.status(200).json({
            success: true,
            loans: enrichedLoans,
            data: enrichedLoans,
            summary: summaryAgg,
            total,
            page,
            pages: Math.ceil(total / limit)
        });
    } catch (err) {
        sendError(res, err);
    }
};

// ─── V1 Backward-Compatible Endpoints ───────────────────────────────────────

// @desc    Get platform overview stats
// @route   GET /api/admin/stats
exports.getStats = async (req, res) => {
    try {
        const [totalUsers, totalLoans, totalChits, activeLoans, activeChits] = await Promise.all([
            User.countDocuments(),
            Loan.countDocuments(),
            ChitFund.countDocuments(),
            Loan.countDocuments({ status: 'active' }),
            ChitFund.countDocuments({ status: 'active' })
        ]);

        const loanVolumeResult = await Loan.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]);
        const totalLoanVolume = loanVolumeResult[0]?.total || 0;

        const chitVolumeResult = await ChitFund.aggregate([{ $group: { _id: null, total: { $sum: '$totalValue' } } }]);
        const totalChitVolume = chitVolumeResult[0]?.total || 0;

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const [newUsers, newLoans] = await Promise.all([
            User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
            Loan.countDocuments({ createdAt: { $gte: thirtyDaysAgo } })
        ]);

        res.json({
            success: true,
            stats: {
                totalUsers, totalLoans, totalChits, activeLoans, activeChits,
                totalLoanVolume, totalChitVolume, newUsers, newLoans
            }
        });
    } catch (err) { sendError(res, err); }
};

// @desc    Get all users (paginated)
// @route   GET /api/admin/users?page=1&search=phone
exports.getUsers = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 30;
        const search = (req.query.search || '').trim();
        const query = search ? {
            $or: [
                { phone: { $regex: search, $options: 'i' } },
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { city: { $regex: search, $options: 'i' } }
            ]
        } : {};

        const [users, total] = await Promise.all([
            User.find(query).select('-password -emailVerificationToken').skip((page - 1) * limit).limit(limit).sort({ createdAt: -1 }),
            User.countDocuments(query)
        ]);

        res.json({ success: true, users, data: users, total, page, pages: Math.ceil(total / limit) });
    } catch (err) { sendError(res, err); }
};

// @desc    Get user detail with loans and chit funds
// @route   GET /api/admin/users/:id
exports.getUserDetail = async (req, res) => {
    try {
        const paramId = req.params.id;
        const query = mongoose.Types.ObjectId.isValid(paramId)
            ? { $or: [{ id: paramId }, { _id: paramId }] }
            : { id: paramId };

        const user = await User.findOne(query).select('-password -emailVerificationToken');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const [loans, chits, creditScore] = await Promise.all([
            Loan.find({ $or: [{ lender: user.id }, { borrower: user.id }, { borrowerPhone: user.phone }] }).sort({ createdAt: -1 }).limit(25),
            ChitFund.find({ $or: [{ owner: user.id }, { 'members.user': user.id }] }).limit(10),
            CreditScore.findOne({ user: user.id })
        ]);

        res.json({ success: true, user, loans, chits, creditScore });
    } catch (err) { sendError(res, err); }
};

// @desc    Suspend or unsuspend a user
// @route   PUT /api/admin/users/:id/suspend
exports.toggleSuspend = async (req, res) => {
    try {
        const { suspend, reason } = req.body;
        const paramId = req.params.id;
        const query = mongoose.Types.ObjectId.isValid(paramId)
            ? { $or: [{ id: paramId }, { _id: paramId }] }
            : { id: paramId };

        const user = await User.findOneAndUpdate(
            query,
            { isSuspended: Boolean(suspend) },
            { new: true }
        ).select('-password');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (req.admin) {
            await logAdminAction(
                req.admin._id,
                suspend ? 'USER_SUSPENDED' : 'USER_UNSUSPENDED',
                reason || (suspend ? 'Suspended by operator' : 'Unsuspended by operator'),
                'SUCCESS',
                req,
                'User',
                user.id
            );
        }

        res.json({ success: true, user, message: suspend ? 'User suspended' : 'User unsuspended' });
    } catch (err) { sendError(res, err); }
};

// @desc    Manually verify user email (Admin support override when user's email provider blocks verification link)
// @route   PUT /api/admin/users/:id/verify-email
exports.verifyUserEmailAdmin = async (req, res) => {
    try {
        const paramId = req.params.id;
        const query = mongoose.Types.ObjectId.isValid(paramId)
            ? { $or: [{ id: paramId }, { _id: paramId }] }
            : { id: paramId };

        const user = await User.findOneAndUpdate(
            query,
            { isEmailVerified: true },
            { new: true }
        ).select('-password');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (user.firebaseUid) {
            try {
                const admin = require('firebase-admin');
                await admin.auth().updateUser(user.firebaseUid, { emailVerified: true });
            } catch (_) {}
        }

        if (req.admin) {
            await logAdminAction(
                req.admin._id,
                'USER_EMAIL_VERIFIED_BY_ADMIN',
                'Manual email verification override by admin',
                'SUCCESS',
                req,
                'User',
                user.id
            );
        }

        res.json({ success: true, user, message: 'User email marked as verified' });
    } catch (err) { sendError(res, err); }
};

// @desc    Get all chit funds (admin view)
// @route   GET /api/admin/chit-funds
exports.getChitFunds = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = 20;
        const filter = {};
        if (req.query.status) filter.status = req.query.status;

        const [chits, total] = await Promise.all([
            ChitFund.find(filter).skip((page - 1) * limit).limit(limit).sort({ createdAt: -1 }),
            ChitFund.countDocuments(filter)
        ]);

        res.json({ success: true, chits, total, page, pages: Math.ceil(total / limit) });
    } catch (err) { sendError(res, err); }
};

// @desc    Make a user admin or remove admin
// @route   PUT /api/admin/users/:id/role
exports.setAdminRole = async (req, res) => {
    try {
        const { isAdmin } = req.body;
        const paramId = req.params.id;
        const query = mongoose.Types.ObjectId.isValid(paramId)
            ? { $or: [{ id: paramId }, { _id: paramId }] }
            : { id: paramId };

        const user = await User.findOneAndUpdate(
            query,
            { isAdmin: Boolean(isAdmin) },
            { new: true }
        ).select('-password');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, user, message: isAdmin ? 'Admin role granted' : 'Admin role removed' });
    } catch (err) { sendError(res, err); }
};
