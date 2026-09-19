const { fireAlert } = require('../utils/AlertManager');
const crypto = require('crypto');
const mongoose = require('mongoose');
const NotificationOutbox = require('../models/NotificationOutbox');
const DeviceToken = require('../models/DeviceToken');
const { sendPushNotification } = require('../utils/fcm');
const { v4: uuidv4 } = require('uuid');

const WORKER_ID = uuidv4();
const MAX_RETRIES = 5;
const LEASE_MS = 2 * 60 * 1000; // 2 minutes

class NotificationWorker {
    static async processOutbox() {
        const { asyncLocalStorage } = require('../utils/asyncContext');
        const logger = require('../utils/logger');
        const jobId = crypto.randomUUID();
        const start = Date.now();

        return new Promise((resolve) => {
            asyncLocalStorage.run({ requestId: jobId, jobName: 'notification_outbox' }, async () => {
                logger.info({ type: 'worker_start' });
                let success = false;
                try {
                    success = await this._processOutboxImpl();
                } catch(e) {
                    logger.error({ type: 'operational_anomaly', anomaly: 'outbox_fatal_error', message: e.message, severity: 'HIGH' });
                } finally {
                    logger.info({
                        type: 'worker_complete',
                        durationMs: Date.now() - start,
                        processedCount: success ? 1 : 0
                    });
                    resolve(success);
                }
            });
        });
    }

    static async _processOutboxImpl() {
        const now = new Date();
        const leaseTimeout = new Date(now.getTime() - LEASE_MS);

        // Claim events: PENDING or (PROCESSING but lease expired)
        const event = await NotificationOutbox.findOneAndUpdate(
            {
                $or: [
                    { status: 'PENDING', nextRetryAt: { $lte: now } },
                    { status: 'PROCESSING', lockedAt: { $lt: leaseTimeout } }
                ]
            },
            {
                $set: {
                    status: 'PROCESSING',
                    lockedAt: now,
                    workerId: WORKER_ID
                }
            },
            { new: true, sort: { nextRetryAt: 1 } }
        );

        if (!event) return false; // No events to process

        try {
            // --- Preference Gate ---
            // IN_APP is always delivered. PUSH/EMAIL honour user preferences.
            // Security/transactional events always pass through.
            if (event.channel === 'PUSH' || event.channel === 'EMAIL') {
                const prefBlocked = await this.isBlockedByPreference(event);
                if (prefBlocked) {
                    // Skip silently — not a failure, just user preference
                    await this.markSent(event); // Mark as sent to avoid re-processing
                    return true;
                }
            }

            if (event.channel === 'PUSH') {
                await this.processPush(event);
            } else if (event.channel === 'EMAIL') {
                await this.processEmail(event);
            } else if (event.channel === 'IN_APP') {
                await this.processInApp(event);
            } else {
                throw new Error(`Unsupported channel: ${event.channel}`);
            }
            return true;
        } catch (error) {
            await this.handleError(event, error);
            return true;
        }
    }

    static async processPush(event) {
        const devices = await DeviceToken.find({ userId: event.recipientUserId, active: true });
        
        if (!devices || devices.length === 0) {
            throw new PermanentError('No active devices found for user');
        }

        let sentCount = 0;
        let lastError = null;

        for (const device of devices) {
            try {
                // FCM send
                const result = await sendPushNotification(
                    device.token, 
                    event.payload.title, 
                    event.payload.body, 
                    { eventId: event.eventId, ...event.payload }
                );
                
                if (result && result.error && result.error.code === 'messaging/invalid-registration-token') {
                    // Invalid token -> Deactivate
                    device.active = false;
                    await device.save();
                } else if (!result || !result.success) {
                    throw new Error(result ? result.message : 'Unknown FCM Error');
                } else {
                    sentCount++;
                }
            } catch (err) {
                lastError = err;
            }
        }

        if (sentCount === 0 && lastError) {
            throw lastError; // All devices failed
        }
        
        await this.markSent(event);
    }

    static async processEmail(event) {
        const User = require('../models/User');
        const user = await User.findById(event.recipientUserId);
        
        if (!user || !user.email) {
            throw new PermanentError('User has no email address');
        }

        const { sendEmail } = require('../utils/email');
        const { loanGivenTemplate } = require('../utils/emailTemplates');

        let subject = event.payload.title;
        let html = `<p>${event.payload.body}</p>`;

        if (event.eventType === 'LOAN_ACTIVATED' && event.payload.amount) {
            subject = `Credit Agreement Activated — ₹${event.payload.amount.toLocaleString('en-IN')}`;
            html = loanGivenTemplate({
                lenderName: event.payload.lenderName,
                borrowerName: event.payload.borrowerName,
                amount: event.payload.amount,
                loanType: event.payload.loanType || 'Credit',
                duration: event.payload.durationMonths,
                interestRate: event.payload.interestRate || 0,
                startDate: new Date(event.payload.startDate).toLocaleDateString('en-IN')
            });
        }

        const result = await sendEmail({
            to: user.email,
            subject,
            html,
            text: event.payload.body
        });

        if (!result.success) {
            throw new Error(result.error || 'Unknown Email Error');
        }

        await this.markSent(event);
    }

    static async processInApp(event) {
        const Notification = require('../models/Notification');
        await Notification.create({
            userId: event.recipientUserId,
            title: event.payload.title,
            body: event.payload.body,
            eventType: event.eventType,
            type: event.payload.type || 'general',
            referenceType: event.aggregateType,
            referenceId: event.aggregateId,
            data: event.payload
        });
        await this.markSent(event);
    }

    /**
     * Check user's notification preferences for this event.
     * Security events (MPIN_CREATED, EMAIL_VERIFIED, ACCOUNT_CREATED) are always delivered.
     * Returns true if the notification should be SUPPRESSED based on preference.
     */
    static async isBlockedByPreference(event) {
        const SECURITY_EVENTS = new Set(['MPIN_CREATED', 'EMAIL_VERIFIED', 'ACCOUNT_CREATED']);
        if (SECURITY_EVENTS.has(event.eventType)) return false; // Always deliver security

        const User = require('../models/User');
        const user = await User.findById(event.recipientUserId).select('notificationPreferences');
        if (!user) return false; // Can't find user — let it through
        
        const prefs = user.notificationPreferences || {};
        const LOAN_EVENTS = new Set([
            'LOAN_CREATED', 'LOAN_RECEIVED', 'AGREEMENT_READY', 'AGREEMENT_ACCEPTED',
            'LOAN_ACTIVATED', 'LOAN_COMPLETED', 'LOAN_CLOSED'
        ]);
        const PAYMENT_EVENTS = new Set(['PAYMENT_RECEIVED', 'PAYMENT_FAILED']);
        const KYC_EVENTS = new Set(['KYC_UPDATE']);
        const CHIT_EVENTS = new Set([
            'CHIT_INVITE', 'CHIT_JOINED', 'CHIT_CONTRIBUTION_DUE',
            'AUCTION_OPENED', 'AUCTION_CLOSED', 'CHIT_PAYOUT'
        ]);

        if (LOAN_EVENTS.has(event.eventType)    && prefs.loanUpdates    === false) return true;
        if (PAYMENT_EVENTS.has(event.eventType) && prefs.paymentUpdates === false) return true;
        if (KYC_EVENTS.has(event.eventType)     && prefs.kycUpdates     === false) return true;
        if (CHIT_EVENTS.has(event.eventType)    && prefs.chitFundUpdates === false) return true;

        return false; // Deliver
    }

    static async markSent(event) {
        event.status = 'SENT';
        event.sentAt = new Date();
        event.lockedAt = null;
        await event.save();
    }

    static async handleError(event, error) {
        const isPermanent = error instanceof PermanentError;
        event.retryCount += 1;
        event.lastError = error.message;
        
        if (isPermanent || event.retryCount >= MAX_RETRIES) {
            event.status = 'DEAD_LETTER';
        } else {
            event.status = 'PENDING';
            // Exponential backoff
            const delayMs = Math.pow(2, event.retryCount) * 1000 * 60; // 2m, 4m, 8m...
            event.nextRetryAt = new Date(Date.now() + delayMs);
        }
        
        event.lockedAt = null;
        event.workerId = null;
        await event.save();
    }
}

class PermanentError extends Error {
    constructor(message) {
        super(message);
        this.name = "PermanentError";
    }
}

module.exports = NotificationWorker;
