const mongoose = require('mongoose');

/**
 * Persistent deduplication / suppression store for operational alerts.
 *
 * Dedup key = anomalyType + identityKey (e.g. loanId or eventId or jobId).
 * When a new anomaly fires, we upsert this record.
 * If the last alert was fired within the suppressionWindowMs, we suppress (do not re-alert).
 * Distinct anomalies with different identity keys are NEVER suppressed by each other.
 */
const AlertRecordSchema = new mongoose.Schema({
    anomalyType: { type: String, required: true },
    identityKey:  { type: String, required: true },    // loanId / eventId / jobId / 'GLOBAL'
    severity:     { type: String, enum: ['LOW','MEDIUM','HIGH','CRITICAL'], required: true },
    status:       { type: String, enum: ['OPEN','SUPPRESSED','RESOLVED'], default: 'OPEN' },
    firstSeenAt:  { type: Date, default: Date.now },
    lastSeenAt:   { type: Date, default: Date.now },
    lastAlertedAt:{ type: Date, default: null },
    suppressedCount: { type: Number, default: 0 },
    context:      { type: mongoose.Schema.Types.Mixed }  // last known diagnostic context
}, { timestamps: true });

AlertRecordSchema.index({ anomalyType: 1, identityKey: 1 }, { unique: true });
AlertRecordSchema.index({ status: 1, severity: 1 });
AlertRecordSchema.index({ lastSeenAt: -1 });

module.exports = mongoose.model('AlertRecord', AlertRecordSchema);
