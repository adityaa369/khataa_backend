const mongoose = require('mongoose');
const { getAlertSummary, resolveAlert } = require('../utils/AlertManager');
const { getTraceContext } = require('../utils/asyncContext');
const OperationalAuditLog = require('../models/OperationalAuditLog');
const NotificationOutbox = require('../models/NotificationOutbox');
const TransactionIntent = require('../models/TransactionIntent');
const AlertRecord = require('../models/AlertRecord');

const { isRedisAvailable } = (() => {
    try { return require('../config/redis'); }
    catch(e) { return { isRedisAvailable: () => false }; }
})();

/**
 * Writes an operational audit entry. Must be called after authorization.
 * Never used as a financial mutation bypass.
 */
const auditOperatorAction = async (req, action, resourceType, resourceId, outcome, details = {}) => {
    const { requestId } = getTraceContext();
    const actor = req.admin || req.user;
    try {
        await OperationalAuditLog.create({
            requestId: requestId || 'UNKNOWN',
            actorId:   actor?._id?.toString() || actor?.id || 'UNKNOWN',
            actorRole: actor?.role || actor?.adminRole || 'UNKNOWN',
            action,
            resourceType,
            resourceId,
            outcome,
            ipAddress: req.ip,
            details
        });
    } catch(e) {
        // Audit failure must not block the operation response
    }
};

/**
 * GET /api/operational/health
 * Authenticated (admin only). Returns system health summary.
 * Does NOT expose financial balances, OTPs, tokens, or sensitive personal data.
 */
const getHealthSummary = async (req, res) => {
    try {
        const [
            alerts,
            deadLetterCount,
            stuckIntentCount,
            stuckProcessingCount
        ] = await Promise.all([
            getAlertSummary(),
            NotificationOutbox.countDocuments({ status: 'DEAD_LETTER' }),
            TransactionIntent.countDocuments({
                status: 'PENDING',
                createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            }),
            NotificationOutbox.countDocuments({
                status: 'PROCESSING',
                lockedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) }
            })
        ]);

        const dbReady = mongoose.connection.readyState === 1;
        const redisReady = isRedisAvailable();
        const criticalAlerts = alerts.filter(a => a.severity === 'CRITICAL' && a.status === 'OPEN');
        const overallHealthy = dbReady && redisReady && criticalAlerts.length === 0;

        const summary = {
            healthy: overallHealthy,
            timestamp: new Date().toISOString(),
            dependencies: {
                database: dbReady ? 'HEALTHY' : 'UNHEALTHY',
                redis:    redisReady ? 'HEALTHY' : 'UNHEALTHY'
            },
            workers: {
                deadLetterNotifications: deadLetterCount,
                stuckIntents:            stuckIntentCount,
                stuckProcessingOutbox:   stuckProcessingCount
            },
            alerts: {
                openCritical: criticalAlerts.length,
                openHigh:     alerts.filter(a => a.severity === 'HIGH' && a.status === 'OPEN').length,
                openMedium:   alerts.filter(a => a.severity === 'MEDIUM' && a.status === 'OPEN').length,
                openLow:      alerts.filter(a => a.severity === 'LOW' && a.status === 'OPEN').length,
                recent:       alerts.slice(0, 20)  // Up to 20 most recent open/suppressed
            }
        };

        await auditOperatorAction(req, 'VIEW_HEALTH', 'OperationalHealth', null, 'SUCCESS');
        return res.status(200).json({ success: true, data: summary });
    } catch(e) {
        return res.status(500).json({ success: false, message: 'Health check failed', error: e.message });
    }
};

/**
 * GET /api/operational/alerts
 * Lists all open/suppressed alerts (paginated).
 */
const listAlerts = async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const status = req.query.status || 'OPEN';

        const alerts = await AlertRecord
            .find({ status })
            .sort({ severity: -1, lastSeenAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .select('anomalyType identityKey severity status firstSeenAt lastSeenAt suppressedCount -_id')
            .lean();

        await auditOperatorAction(req, 'LIST_ALERTS', 'AlertRecord', null, 'SUCCESS', { status, page });
        return res.status(200).json({ success: true, data: alerts, page, limit });
    } catch(e) {
        return res.status(500).json({ success: false, message: 'Failed to list alerts', error: e.message });
    }
};

/**
 * POST /api/operational/alerts/:anomalyType/:identityKey/resolve
 * Operator acknowledges/resolves an alert. Audited.
 * Does NOT mutate any financial data.
 */
const acknowledgeAlert = async (req, res) => {
    const { anomalyType, identityKey } = req.params;
    const { reason } = req.body;

    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
        return res.status(400).json({ success: false, message: 'reason is required (min 5 chars)' });
    }

    try {
        const record = await resolveAlert(anomalyType, identityKey, req.admin?._id);
        if (!record) {
            return res.status(404).json({ success: false, message: 'Alert not found' });
        }

        await auditOperatorAction(
            req, 'ACKNOWLEDGE_ALERT', 'AlertRecord',
            `${anomalyType}|${identityKey}`, 'SUCCESS',
            { reason: reason.trim(), anomalyType, identityKey }
        );

        return res.status(200).json({ success: true, message: 'Alert resolved', data: { anomalyType, identityKey } });
    } catch(e) {
        await auditOperatorAction(
            req, 'ACKNOWLEDGE_ALERT', 'AlertRecord',
            `${anomalyType}|${identityKey}`, 'FAILURE',
            { error: e.message }
        );
        return res.status(500).json({ success: false, message: 'Failed to resolve alert', error: e.message });
    }
};

/**
 * GET /api/operational/audit-log
 * Read-only view of operational audit trail.
 */
const getOperationalAuditLog = async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);

        const entries = await OperationalAuditLog
            .find({})
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .select('-__v -details') // exclude raw details for list view
            .lean();

        await auditOperatorAction(req, 'VIEW_AUDIT_LOG', 'OperationalAuditLog', null, 'SUCCESS', { page });
        return res.status(200).json({ success: true, data: entries, page, limit });
    } catch(e) {
        return res.status(500).json({ success: false, message: 'Failed to fetch audit log', error: e.message });
    }
};

module.exports = { getHealthSummary, listAlerts, acknowledgeAlert, getOperationalAuditLog };
