const mongoose = require('mongoose');

const ChitTransactionSchema = new mongoose.Schema({
    chitFund: { type: mongoose.Schema.Types.ObjectId, ref: 'ChitFund', required: true },
    chitSubscription: { type: mongoose.Schema.Types.ObjectId, ref: 'ChitSubscription', required: true },
    user: { type: String, required: true, ref: 'User' },
    monthNumber: { type: Number, required: true },
    amount: { type: Number, required: true },
    transactionId: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    verifiedBy: { type: String, ref: 'User' },
    verifiedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('ChitTransaction', ChitTransactionSchema);
