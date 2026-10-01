const mongoose = require('mongoose');
const NotificationOutbox = require('../models/NotificationOutbox');
const SmsProvider = require('../utils/smsProvider');
const EncryptionUtil = require('../utils/encryption');
const { v4: uuidv4 } = require('uuid');

const WORKER_ID = uuidv4();

class SmsWorker {
    static async processSmsOutbox() {
        const lockTime = new Date(Date.now() - 5 * 60 * 1000); // 5 mins lock timeout

        // 1. Recover stale locked events
        await NotificationOutbox.updateMany(
            { 
                channel: 'SMS', 
                status: 'PROCESSING', 
                lockedAt: { $lt: lockTime } 
            },
            { 
                $set: { status: 'PENDING', lockedAt: null, workerId: null } 
            }
        );

        // 2. Find up to 10 pending SMS events
        const events = await NotificationOutbox.find({
            channel: 'SMS',
            status: 'PENDING',
            nextRetryAt: { $lte: new Date() }
        }).limit(10);

        if (events.length === 0) return;

        for (const event of events) {
            // Lock event
            const lockedEvent = await NotificationOutbox.findOneAndUpdate(
                { _id: event._id, status: 'PENDING' },
                { $set: { status: 'PROCESSING', lockedAt: new Date(), workerId: WORKER_ID } },
                { new: true }
            );

            if (!lockedEvent) continue; // Concurrency check

            try {
                // SMS specific logic
                const { phone, encryptedOtp, amountPaise } = lockedEvent.payload;

                if (!phone || !encryptedOtp) {
                    throw new PermanentError('Missing phone or encrypted OTP payload');
                }

                // Decrypt OTP safely in memory
                const rawOtp = EncryptionUtil.decrypt(encryptedOtp);
                if (!rawOtp) {
                    throw new PermanentError('Failed to decrypt OTP payload');
                }

                // Send SMS via Provider
                const result = await SmsProvider.sendTransactionalOtp(phone, rawOtp, amountPaise);

                if (!result.success) {
                    // Error from provider
                    throw new Error(result.error || 'Provider rejected request');
                }

                // Success!
                lockedEvent.status = 'SENT';
                lockedEvent.sentAt = new Date();
                lockedEvent.providerId = result.providerMessageId;
            } catch (err) {
                console.error(`[SmsWorker] Delivery failed for outbox ${lockedEvent._id}:`, err.message);
                
                lockedEvent.lastError = err.message;
                lockedEvent.retryCount += 1;

                if (err instanceof PermanentError || lockedEvent.retryCount >= 3) {
                    lockedEvent.status = 'DEAD_LETTER';
                } else {
                    lockedEvent.status = 'PENDING';
                    // Exponential backoff
                    const delayMs = Math.pow(2, lockedEvent.retryCount) * 1000 * 30; // 30s, 60s, 120s...
                    lockedEvent.nextRetryAt = new Date(Date.now() + delayMs);
                }
            } finally {
                lockedEvent.lockedAt = null;
                lockedEvent.workerId = null;
                // Delete encrypted OTP from payload when done
                if (['SENT', 'DEAD_LETTER'].includes(lockedEvent.status)) {
                    delete lockedEvent.payload.encryptedOtp;
                    lockedEvent.markModified('payload');
                }
                await lockedEvent.save();
            }
        }
    }
}

class PermanentError extends Error {
    constructor(message) {
        super(message);
        this.name = "PermanentError";
    }
}

module.exports = SmsWorker;
