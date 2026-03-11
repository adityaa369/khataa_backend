const mongoose = require('mongoose');

const ChitAuctionSchema = new mongoose.Schema({
    chitFund: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChitFund',
        required: true
    },
    monthNumber: {
        type: Number,
        required: true
    },
    auctionDate: {
        type: Date,
        required: true
    },
    winnerUserId: {
        type: String, // Matches custom User ID logic
        ref: 'User',
        required: true
    },
    winningBidDiscount: {
        type: Number,
        required: [true, 'Winning discount amount is required']
    },
    dividendPerMember: {
        type: Number,
        required: true
    },
    prizeMoneyPaid: {
        type: Number,
        required: true,
        comment: 'Total value minus discount minus organizer fee'
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('ChitAuction', ChitAuctionSchema);
