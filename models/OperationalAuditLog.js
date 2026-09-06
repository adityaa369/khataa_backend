const mongoose = require('mongoose');

/**
 * Audit log for operational control actions (alert acknowledge, incident status update,
 * worker trigger, health query, etc.).
 *
 * This is DISTINCT from:
 *   - AdminAuditLog (general admin CRUD)
 *   - Transaction ledger (financial source of truth)
 *
 * Financial mutations MUST still flow through the domain service + ledger path.
 * This log covers the "operational control plane" only.
 */
const OperationalAuditLogSchema = new mongoose.Schema({
    requestId:    { type: String, required: true },
    actorId:      { type: String, required: true },    // admin userId
    actorRole:    { type: String },
    action:       { type: String, required: true },    // e.g. ACKNOWLEDGE_ALERT, VIEW_HEALTH
    resourceType: { type: String },                    // AlertRecord, WorkerStatus, etc.
    resourceId:   { type: String },
    outcome:      { type: String, enum: ['SUCCESS','FAILURE','UNAUTHORIZED'], required: true },
    reason:       { type: String },
    ipAddress:    { type: String },
    details:      { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

OperationalAuditLogSchema.index({ actorId: 1, createdAt: -1 });
OperationalAuditLogSchema.index({ action: 1 });
OperationalAuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('OperationalAuditLog', OperationalAuditLogSchema);
