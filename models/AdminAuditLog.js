const mongoose = require('mongoose');

const AdminAuditLogSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    action: { type: String, required: true, index: true },
    resourceType: { type: String }, // e.g., 'Incident', 'KillSwitch'
    resourceId: { type: String },
    reason: { type: String, required: true },
    ipAddress: { type: String },
    requestId: { type: String },
    status: { type: String, enum: ['SUCCESS', 'FAILURE'], required: true },
    details: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

AdminAuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', AdminAuditLogSchema);
