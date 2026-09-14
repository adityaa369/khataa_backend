const mongoose = require('mongoose');

const FinancialKillSwitchSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, default: 'FINANCIAL' },
    enabled: { type: Boolean, required: true, default: false },
    reason: { type: String },
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    activatedAt: { type: Date },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

module.exports = mongoose.model('FinancialKillSwitch', FinancialKillSwitchSchema);
