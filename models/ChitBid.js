const mongoose = require('mongoose');

const ChitBidSchema = new mongoose.Schema({
    chitFund: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChitFund',
        required: true
    },
    monthNumber: {
        type: Number,
        required: true
    },
    user: {
        type: String, // Referencing custom user IDs
        ref: 'User',
        required: true
    },
    bidDiscount: {
        type: Number,
        required: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('ChitBid', ChitBidSchema);
