const mongoose = require('mongoose');

const SecurityEventSchema = new mongoose.Schema({
    eventType: { type: String, required: true, index: true }, // e.g., OTP_REPLAY, RATE_LIMIT_EXCEEDED
    severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'MEDIUM' },
    result: { type: String, enum: ['SUCCESS', 'BLOCKED', 'FAILED'], required: true },
    userReference: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    resourceReference: { type: String }, // e.g., KH-10293
    requestId: { type: String, index: true },
    sourceIp: { type: String },
    financialImpact: { type: String, enum: ['NONE', 'ATTEMPTED', 'BLOCKED', 'REACHED_FINANCIAL_LOGIC'], required: true },
    description: { type: String },
    technicalDetails: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

module.exports = mongoose.model('SecurityEvent', SecurityEventSchema);
