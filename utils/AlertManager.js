const crypto = require('crypto');
const logger = require('./logger');
const { getTraceContext } = require('./asyncContext');

let AlertRecord;
const getAlertRecord = () => {
    if (!AlertRecord) AlertRecord = require('../models/AlertRecord');
    return AlertRecord;
};

/**
 * Alert definitions.
 * Each entry specifies: severity, suppressionWindowMs.
 *
 * suppressionWindowMs: once an alert fires for a given (anomalyType + identityKey),
 * further firings within this window are suppressed (counted but not re-logged as a new alert).
 * Distinct anomalies (different identityKey) are NEVER suppressed by each other.
 *
 * Thresholds that produce HIGH/CRITICAL require distinct anomaly evidence — transient
 * single-occurrence events at LOW/MEDIUM may fire more freely.
 */
const ALERT_DEFINITIONS = {
    RECONCILIATION_MISMATCH:    { severity: 'CRITICAL', suppressionWindowMs: 30 * 60 * 1000 },  // 30 min
    NEGATIVE_BALANCE:           { severity: 'CRITICAL', suppressionWindowMs: 30 * 60 * 1000 },
    NOTIFICATION_DEAD_LETTER:   { severity: 'MEDIUM',   suppressionWindowMs: 60 * 60 * 1000 },  // 1 hour
    REPEATED_WORKER_FAILURE:    { severity: 'HIGH',     suppressionWindowMs: 15 * 60 * 1000 },  // 15 min
    STUCK_INTENT:               { severity: 'MEDIUM',   suppressionWindowMs: 2 * 60 * 60 * 1000 }, // 2 hours
    STUCK_OUTBOX:               { severity: 'LOW',      suppressionWindowMs: 2 * 60 * 60 * 1000 },
    IDEMPOTENCY_CONFLICT_SPIKE: { severity: 'HIGH',     suppressionWindowMs: 10 * 60 * 1000 },  // 10 min
    DEPENDENCY_UNAVAILABLE:     { severity: 'CRITICAL', suppressionWindowMs: 5 * 60 * 1000 },   // 5 min
};

// In-memory suppression cache to avoid DB round-trips for the common case.
// Key: "anomalyType|identityKey"  Value: timestamp of last alert
const suppressionCache = new Map();

/**
 * Fire an alert.
 *
 * @param {string} anomalyType  - One of ALERT_DEFINITIONS keys
 * @param {string} identityKey  - Stable entity identity (loanId, eventId, jobId, 'GLOBAL', etc.)
 * @param {object} context      - Runbook diagnostic context. Must NOT contain OTPs, tokens,
 *                                signed URLs, KYC payloads, or unnecessary sensitive data.
 * @returns {Promise<{ fired: boolean, suppressed: boolean }>}
 */
const fireAlert = async (anomalyType, identityKey, context = {}) => {
    const def = ALERT_DEFINITIONS[anomalyType];
    if (!def) {
        logger.error({ type: 'alert_manager_error', message: 'Unknown anomalyType', anomalyType });
        return { fired: false, suppressed: false };
    }

    const cacheKey = `${anomalyType}|${identityKey}`;
    const now = Date.now();
    const lastAlerted = suppressionCache.get(cacheKey) || 0;

    if (now - lastAlerted < def.suppressionWindowMs) {
        // Suppressed — count the suppression but do not re-alert
        getAlertRecord().findOneAndUpdate(
            { anomalyType, identityKey },
            { $inc: { suppressedCount: 1 }, $set: { lastSeenAt: new Date(), status: 'SUPPRESSED' } },
            { upsert: true }
        ).catch(() => {});
        return { fired: false, suppressed: true };
    }

    // Fire the alert
    suppressionCache.set(cacheKey, now);

    const { requestId } = getTraceContext();
    const alertPayload = {
        type: 'alert',
        anomalyType,
        severity: def.severity,
        identityKey,
        requestId,
        ...context,
        firedAt: new Date().toISOString()
    };

    logger.error(alertPayload);

    // Persist to AlertRecord (upsert)
    getAlertRecord().findOneAndUpdate(
        { anomalyType, identityKey },
        {
            $set: { severity: def.severity, lastSeenAt: new Date(), lastAlertedAt: new Date(), status: 'OPEN', context },
            $setOnInsert: { firstSeenAt: new Date(), suppressedCount: 0 }
        },
        { upsert: true }
    ).catch(() => {});

    return { fired: true, suppressed: false };
};

/**
 * Mark an alert as resolved (operator acknowledgement).
 * This does NOT modify financial data.
 */
const resolveAlert = async (anomalyType, identityKey, resolvedBy) => {
    const cacheKey = `${anomalyType}|${identityKey}`;
    suppressionCache.delete(cacheKey); // Clear suppression so a new occurrence will re-fire
    return getAlertRecord().findOneAndUpdate(
        { anomalyType, identityKey },
        { $set: { status: 'RESOLVED', lastSeenAt: new Date() } },
        { new: true }
    );
};

/**
 * Returns open/suppressed alert summary for the operational health endpoint.
 * Does not expose financial balances or sensitive personal data.
 */
const getAlertSummary = async () => {
    const AR = getAlertRecord();
    const alerts = await AR.find({ status: { $in: ['OPEN', 'SUPPRESSED'] } })
        .sort({ severity: -1, lastSeenAt: -1 })
        .limit(100)
        .select('anomalyType identityKey severity status firstSeenAt lastSeenAt suppressedCount -_id')
        .lean();
    return alerts;
};

module.exports = { fireAlert, resolveAlert, getAlertSummary, ALERT_DEFINITIONS };
