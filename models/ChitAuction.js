const mongoose = require('mongoose');

// Authoritative LIVE auction state
const ChitAuctionSchema = new mongoose.Schema({
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChitGroup',
        required: true,
        index: true
    },
    cycleIndex: {
        type: Number,
        required: true
    },
    status: {
        type: String,
        enum: ['scheduled', 'open', 'closed'],
        default: 'open'
    },
    currentLowestBid: {
        type: Number, // In Paise
        default: null
    },
    currentWinner: {
        type: String, // User ID
        ref: 'User',
        default: null
    },
    startTime: {
        type: Date,
        required: true
    },
    endTime: {
        type: Date,
        required: true
    }
}, { timestamps: true });

// Prevent duplicate auctions for the same cycle
ChitAuctionSchema.index({ groupId: 1, cycleIndex: 1 }, { unique: true });

module.exports = mongoose.model('ChitAuction', ChitAuctionSchema);
