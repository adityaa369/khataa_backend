const mongoose = require('mongoose');

const ChitLedgerSchema = new mongoose.Schema({
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChitGroup',
        required: true
    },
    cycleIndex: {
        type: Number,
        required: true
    },
    auctionStartTime: {
        type: Date,
        required: true
    },
    auctionEndTime: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['scheduled', 'open', 'processing_validation', 'settled'],
        default: 'scheduled'
    },
    winnerUser: {
        type: String, // User ID
        ref: 'User',
        default: null
    },
    winningBidDiscount: {
        type: Number, // Scaled integer (paise/cents)
        default: 0
    },
    commissionExtracted: {
        type: Number,
        default: 0
    },
    dividendPerHead: {
        type: Number,
        default: 0
    },
    netPayable: {
        type: Number, // Base EMI - dividend
        default: 0
    }
}, {
    timestamps: true
});

// Compound index to ensure only one ledger per cycle per group
ChitLedgerSchema.index({ groupId: 1, cycleIndex: 1 }, { unique: true });

module.exports = mongoose.model('ChitLedger', ChitLedgerSchema);
