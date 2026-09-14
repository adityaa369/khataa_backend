const mongoose = require('mongoose');

const TransactionIntentSchema = new mongoose.Schema({
    intentId: {
        type: String,
        required: true,
        unique: true
    },
    loanId: {
        type: String,
        required: true
    },
    action: {
        type: String,
        required: true,
        enum: ['CLOSE_LOAN', 'PAYMENT', 'ADD_CREDIT']
    },
    status: {
        type: String,
        enum: ['PENDING', 'COMMITTED', 'REJECTED'],
        default: 'PENDING'
    },
    userId: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 86400 // Intenets expire after 24h
    }
});

module.exports = mongoose.model('TransactionIntent', TransactionIntentSchema);
