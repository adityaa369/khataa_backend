const mongoose = require('mongoose');

const ReconciliationIncidentSchema = new mongoose.Schema({
    invariantCode: { type: String, required: true, index: true },
    severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], required: true },
    entityType: { type: String, required: true }, // 'Loan', 'ChitLedger', 'LedgerEntry'
    entityId: { type: String, required: true },
    expectedValue: { type: mongoose.Schema.Types.Mixed },
    actualValue: { type: mongoose.Schema.Types.Mixed },
    details: { type: String },
    status: { type: String, enum: ['OPEN', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE'], default: 'OPEN' },
    detectedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    resolvedBy: { type: String }, // User/Admin ID
    resolutionNotes: { type: String }
});

module.exports = mongoose.model('ReconciliationIncident', ReconciliationIncidentSchema);
