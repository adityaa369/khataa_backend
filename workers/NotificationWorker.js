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
            if (event.channel === 'PUSH') {
                await this.processPush(event);
            } else if (event.channel === 'EMAIL') {
                // Email logic here
                await this.markSent(event);
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
