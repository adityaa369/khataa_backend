const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const intentSchema = new mongoose.Schema({
    intentId: { type: String, default: uuidv4, unique: true },
    loanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan', required: true },
    userId: { type: String, required: true }, 
    action: { type: String, enum: ['ACCEPT_LOAN', 'ADD_CREDIT', 'RECORD_PAYMENT', 'CLOSE_LOAN', 'WRITE_OFF', 'REVERSE'], required: true },
    
    payload: {
        amountPaise: { type: Number, required: true, validate: Number.isInteger },
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
    },
    
    status: { type: String, enum: ['PENDING', 'CONSUMED', 'EXPIRED'], default: 'PENDING' },
    expiresAt: { type: Date, required: true } 
    // TTL index REMOVED to preserve audit history. 
    // The service must check `now < expiresAt` manually.
}, { timestamps: true });

module.exports = mongoose.model('TransactionIntent', intentSchema);
