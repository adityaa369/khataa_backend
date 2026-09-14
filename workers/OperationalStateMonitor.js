const { fireAlert } = require('../utils/AlertManager');
const mongoose = require('mongoose');
const Intent = require('../models/TransactionIntent');
const NotificationOutbox = require('../models/NotificationOutbox');
const logger = require('../utils/logger');

// Explicit Deterministic Thresholds
const INTENT_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours
const OUTBOX_PENDING_STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours
const OUTBOX_PROCESSING_STALE_AFTER_MS = 10 * 60 * 1000; // 10 minutes

class OperationalStateMonitor {
    /**
     * Read-only monitor that scans the database for stuck operational states.
     * Generates structured operational_anomaly logs but does NOT repair/mutate data.
     */
    static async runMonitor() {
        const now = new Date();
        const results = { anomaliesDetected: 0 };

        // 1. Stuck Intents
        const staleIntentThreshold = new Date(now.getTime() - INTENT_STALE_AFTER_MS);
        const stuckIntents = await Intent.find({
            status: 'PENDING',
            createdAt: { $lt: staleIntentThreshold }
        });

        for (const intent of stuckIntents) {
            await fireAlert('STUCK_INTENT', intent._id.toString(), {
                intentId: intent._id.toString(),
                loanId: intent.loanId ? intent.loanId.toString() : undefined,
                createdAt: intent.createdAt,
                subsystem: 'OperationalStateMonitor'
            });
            results.anomaliesDetected++;
        }

        // 2. Stuck Outbox (PENDING)
        const stalePendingThreshold = new Date(now.getTime() - OUTBOX_PENDING_STALE_AFTER_MS);
        const stuckPendingOutbox = await NotificationOutbox.find({
            status: 'PENDING',
            createdAt: { $lt: stalePendingThreshold }
        });

        for (const event of stuckPendingOutbox) {
            await fireAlert('STUCK_OUTBOX', event.eventId, {
                eventId: event.eventId,
                outboxStatus: 'PENDING',
                createdAt: event.createdAt,
                subsystem: 'OperationalStateMonitor'
            });
            results.anomaliesDetected++;
        }

        // 3. Stuck Outbox (PROCESSING)
        const staleProcessingThreshold = new Date(now.getTime() - OUTBOX_PROCESSING_STALE_AFTER_MS);
        const stuckProcessingOutbox = await NotificationOutbox.find({
            status: 'PROCESSING',
            lockedAt: { $lt: staleProcessingThreshold }
        });

        for (const event of stuckProcessingOutbox) {
            await fireAlert('STUCK_OUTBOX', event.eventId, {
                eventId: event.eventId,
                outboxStatus: 'PROCESSING',
                lockedAt: event.lockedAt,
                workerId: event.workerId,
                subsystem: 'OperationalStateMonitor'
            });
            results.anomaliesDetected++;
        }

        // 4. Dead Letter Outbox
        const deadLetterOutbox = await NotificationOutbox.find({
            status: 'DEAD_LETTER'
        });
        
        // In a real system we'd track last logged time to avoid spamming, but for this snapshot we log them all
        for (const event of deadLetterOutbox) {
            await fireAlert('NOTIFICATION_DEAD_LETTER', event.eventId, {
                eventId: event.eventId,
                retryCount: event.retryCount,
                lastError: event.lastError,
                subsystem: 'OperationalStateMonitor'
            });
        }

        return results;
    }
}

module.exports = OperationalStateMonitor;
