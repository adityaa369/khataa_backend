const mongoose = require('mongoose');

const ChitFundSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Please add a chit name or identifier'],
        unique: true,
        trim: true
    },
    totalValue: {
        type: Number,
        required: [true, 'Please add total chit value']
    },
    totalMonths: {
        type: Number,
        required: [true, 'Please add total months/members length']
    },
    monthlySubscription: {
        type: Number,
        required: [true, 'Please add monthly subscription value']
    },

    owner: {
        type: String, // Referencing custom user IDs
        ref: 'User',
        required: true
    },
    currentSubscribersCount: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['registration', 'active', 'completed'],
        default: 'registration'
    },
    completedMonths: {
        type: Number,
        default: 0
    },
    startDate: {
        type: Date
    },
    branchName: {
        type: String,
        default: 'KPHB-CAO'
    },
    activeAuctionMonth: {
        type: Number,
        default: null
    },
    activeAuctionBaseAmount: {
        type: Number,
        default: null
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('ChitFund', ChitFundSchema);
