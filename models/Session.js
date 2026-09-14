const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
    userId: {
        type: String, // Matches the custom string IDs used in Khatha (or ObjectId depending on User schema)
        ref: 'User',
        required: true,
        index: true
    },
    refreshTokenHash: {
        type: String,
        required: true
    },
    deviceInfo: {
        type: String,
        default: 'Unknown Device'
    },
    ipAddress: {
        type: String
    },
    lastUsedAt: {
        type: Date,
        default: Date.now
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expires: '1s' } // MongoDB automatically cleans up expired sessions
    },
    revokedAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

module.exports = mongoose.model('Session', SessionSchema);
