const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const notificationOutboxSchema = new mongoose.Schema({
    eventId: { type: String, default: uuidv4, unique: true },
    aggregateType: { type: String, required: true }, // e.g., 'LOAN', 'USER'
    aggregateId: { type: String, required: true },
    eventType: { type: String, required: true }, // e.g., 'PAYMENT_COMMITTED', 'EMAIL_VERIFICATION_REQUESTED'
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    channel: { type: String, enum: ['PUSH', 'EMAIL', 'SMS'], required: true },
    
    payload: { type: mongoose.Schema.Types.Mixed, required: true }, // Safe, non-sensitive data
    
    status: { 
        type: String, 
        enum: ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTER'], 
        default: 'PENDING',
        index: true
    },
    
    retryCount: { type: Number, default: 0 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    lastError: { type: String },
    
    lockedAt: { type: Date },
    workerId: { type: String },
    sentAt: { type: Date }
}, { timestamps: true });

// Optimizes the worker's polling query
notificationOutboxSchema.index({ status: 1, nextRetryAt: 1 });

module.exports = mongoose.model('NotificationOutbox', notificationOutboxSchema);
