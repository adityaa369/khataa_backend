const mongoose = require('mongoose');

const SecurityEventSchema = new mongoose.Schema({
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true, index: true },
    severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'MEDIUM' },
    actorType: { type: String, enum: ['USER', 'ADMIN', 'SYSTEM', 'ANONYMOUS'], default: 'ANONYMOUS' },
    actorId: { type: String, index: true },
    requestId: { type: String, index: true },
    ipReference: { type: String },
    route: { type: String },
    result: { type: String, enum: ['SUCCESS', 'BLOCKED', 'FAILED'] },
    financialImpact: { type: String, enum: ['NONE', 'ATTEMPTED', 'COMMITTED'], default: 'NONE' },
    reachedFinancialLogic: { type: Boolean, default: false },
    resourceType: { type: String },
    resourceId: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

SecurityEventSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SecurityEvent', SecurityEventSchema);
