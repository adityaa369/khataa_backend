const mongoose = require('mongoose');

const deviceTokenSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ['android', 'ios', 'web', 'unknown'], default: 'unknown' },
    appVersion: { type: String },
    lastSeenAt: { type: Date, default: Date.now },
    active: { type: Boolean, default: true, index: true }
}, { timestamps: true });

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
