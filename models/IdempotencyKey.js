const mongoose = require('mongoose');

const IdempotencyKeySchema = new mongoose.Schema({
    key: {
        type: String,
        required: true
    },
    user: {
        type: String,
        required: true
    },
    requestPath: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['IN_PROGRESS', 'COMPLETED'],
        default: 'IN_PROGRESS'
    },
    responseStatus: {
        type: Number
    },
    responseBody: {
        type: mongoose.Schema.Types.Mixed
    },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
        index: { expires: '1s' }
    }
}, { timestamps: true });

// Ensure uniqueness per user per key
IdempotencyKeySchema.index({ key: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('IdempotencyKey', IdempotencyKeySchema);
