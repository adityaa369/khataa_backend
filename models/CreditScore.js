const mongoose = require('mongoose');

const CreditScoreSchema = new mongoose.Schema({
    user: {
        type: String,
        ref: 'User',
        required: true,
        unique: true
    },
    cibilScore: {
        type: Number,
        default: 0
    },
    experianScore: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        default: 'Processing'
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('CreditScore', CreditScoreSchema);
