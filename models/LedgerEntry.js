const mongoose = require('mongoose');

const LedgerEntrySchema = new mongoose.Schema({
    // Universally unique ID for the ledger event
    transactionId: {
        type: String,
        required: true,
        unique: true
    },
    // The account being affected. E.g., 'USER:9876543210', 'CHIT_GROUP:abc1234', 'SYSTEM:FEE_COLLECTION'
    account: {
        type: String,
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['DEBIT', 'CREDIT'],
        required: true
    },
    // Amount MUST always be an absolute Integer representing Paise (1/100th of an INR)
    amountPaise: {
        type: Number,
        required: true,
        validate: {
            validator: Number.isInteger,
            message: 'amountPaise must be an integer'
        },
        min: [1, 'Amount must be greater than zero']
    },
    // Linking to the specific domain model (e.g. Loan, ChitFund)
    referenceModel: {
        type: String,
        enum: ['Loan', 'ChitGroup', 'ChitAuction', 'System'],
        required: true
    },
    referenceId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    // Prevent duplicate processing from the API layer
    idempotencyKey: {
        type: String,
        sparse: true, 
        unique: true
    },
    description: {
        type: String
    }
}, { timestamps: true });

// A compound index for quickly pulling a user's chronological statement of account
LedgerEntrySchema.index({ account: 1, createdAt: -1 });

module.exports = mongoose.model('LedgerEntry', LedgerEntrySchema);
