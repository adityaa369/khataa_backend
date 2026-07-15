const mongoose = require('mongoose');

const SubscriberSchema = new mongoose.Schema({
    user: {
        type: String, // User ID
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['invited', 'joined', 'verified', 'defaulted'],
        default: 'joined'
    },
    hasWon: {
        type: Boolean,
        default: false
    },
    wonInCycle: {
        type: Number,
        default: null
    }
}, { _id: false });

const ChitGroupSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    creator: {
        type: String, // User ID of Foreman
        ref: 'User',
        required: true
    },
    totalValue: {
        type: Number, // Stored in lowest denominator (paise/cents)
        required: true
    },
    durationMonths: {
        type: Number,
        required: true
    },
    maxSubscribers: {
        type: Number,
        required: true
    },
    commissionPercentage: {
        type: Number,
        default: 5.0, // e.g., 5%
        required: true
    },
    currentCycle: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['drafting', 'upcoming', 'active', 'settled'],
        default: 'drafting'
    },
    subscribers: [SubscriberSchema],
    startDate: Date,
    endDate: Date
}, {
    timestamps: true
});

module.exports = mongoose.model('ChitGroup', ChitGroupSchema);
