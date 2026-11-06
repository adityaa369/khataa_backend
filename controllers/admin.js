const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const os = require('os');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Loan = require('../models/Loan');
const ChitFund = require('../models/ChitFund');
const CreditScore = require('../models/CreditScore');
const LedgerEntry = require('../models/LedgerEntry');
const Transaction = require('../models/Transaction');
const ReconciliationIncident = require('../models/ReconciliationIncident');
const FinancialKillSwitch = require('../models/FinancialKillSwitch');
const { cacheSet, cacheGet, getRedisClient, isRedisAvailable } = require('../config/redis');
const { logAdminAction } = require('../middleware/adminAuth');
const { getMetricsSnapshot } = require('../middleware/metrics');

function sendError(res, err, status = 500) {
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
        return res.status(500).json({ success: false, message: 'Internal Server Error during login' });
    }
};

// @desc    Operations Dashboard Snapshot
// @route   GET /api/admin/dashboard
exports.getDashboard = async (req, res) => {
    try {
        const incidents = await ReconciliationIncident.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);

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
        const dbLatency = Number(process.hrtime.bigint() - dbStart) / 1e6;

        // Redis / Cache Latency check (graceful fallback when REDIS_URL is not configured)
        const redisStart = process.hrtime.bigint();
        let redisStatus = isRedisAvailable() ? 'READY' : 'IN_MEMORY_FALLBACK';
        if (redisStatus === 'READY') {
            try {
                const client = getRedisClient();
                await client.ping();
            } catch {
                redisStatus = 'IN_MEMORY_FALLBACK';
            }
        }
        const redisLatency = Number(process.hrtime.bigint() - redisStart) / 1e6;

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

        const infrastructure = {
            database: { status: dbStatus, latencyMs: Math.round(dbLatency) },
            redis: { status: 'READY', mode: redisStatus, latencyMs: Math.round(redisLatency) },
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
            killSwitchEnabled
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
