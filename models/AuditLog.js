const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema({
    userId: { type: String, required: true }, // Who did it
    action: { 
        type: String, 
        enum: [
            'KYC_VIEWED', 
            'KYC_UPDATED', 
            'KYC_VERIFICATION_REQUESTED', 
            'KYC_DOCUMENT_ACCESSED'
        ], 
        required: true 
    },
    resourceId: { type: String, required: true }, // Whose KYC was viewed
    context: { type: String }, // Why
    ipAddress: { type: String },
    timestamp: { type: Date, default: Date.now }
});

AuditLogSchema.index({ userId: 1, timestamp: -1 });
AuditLogSchema.index({ resourceId: 1, timestamp: -1 });

module.exports = mongoose.model('AuditLog', AuditLogSchema);

