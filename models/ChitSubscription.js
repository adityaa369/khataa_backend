const mongoose = require('mongoose');

const ChitSubscriptionSchema = new mongoose.Schema({
    user: {
        type: String, // String ID matching custom user IDs e.g. user_xyz
        required: [true, 'User ID is required'],
        ref: 'User'
    },
    chitFund: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChitFund',
        required: true
    },
    installmentsPaid: {
        type: Number,
        default: 0
    },
    hasWonAuction: {
        type: Boolean,
        default: false
    },
    wonMonth: {
        type: Number,
        default: null
    },
    totalDividendEarned: {
        type: Number,
        default: 0
    },
    transactions: [{
        monthNumber: Number,
        amountPaid: Number,
        transactionId: String,
        date: Date
    }],
    status: {
        type: String,
        enum: ['active', 'defaulted', 'completed'],
        default: 'active'
    }
}, {
    timestamps: true
});

// Prevent duplicate subscriptions to the same chit fund by the same user
ChitSubscriptionSchema.index({ user: 1, chitFund: 1 }, { unique: true });

module.exports = mongoose.model('ChitSubscription', ChitSubscriptionSchema);
