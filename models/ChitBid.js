const mongoose = require('mongoose');

// Immutable accepted bid event
const ChitBidSchema = new mongoose.Schema({
    auctionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChitAuction',
        required: true,
        index: true
    },
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChitGroup',
        required: true
    },
    cycleIndex: {
        type: Number,
        required: true
    },
    userId: {
        type: String, // Referencing custom user IDs
        ref: 'User',
        required: true
    },
    bidDiscountPaise: {
        type: Number,
        required: true
    },
    sequenceNumber: {
        type: Number,
        // Useful if we wanted to enforce strict ordering, but createdAt helps.
    },
    idempotencyKey: {
        type: String,
        sparse: true,
        unique: true
    }
}, { timestamps: true });

module.exports = mongoose.model('ChitBid', ChitBidSchema);
