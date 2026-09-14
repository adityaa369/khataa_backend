const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const MAX_PAISE = Number.MAX_SAFE_INTEGER;

const transactionSchema = new mongoose.Schema({
    transactionId: { type: String, default: uuidv4, unique: true },
    loanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan', required: true },
    sequenceNumber: { type: Number, required: true }, // Deterministic ordering
    
    type: {
        type: String,
        enum: ['LOAN_CREATED', 'CREDIT_ADDED', 'INTEREST_ACCRUED', 'FEE_ASSESSED', 'PAYMENT', 'REVERSAL', 'WRITE_OFF'],
        required: true
    },
    actorId: { type: String, required: true },
    currency: { type: String, default: 'INR', required: true },
    
    // Time tracking
    createdAt: { type: Date, default: Date.now }, 
    effectiveAt: { type: Date, required: true },  
    businessDate: { type: String, required: true }, 
    
    // Signed Accounting Deltas
    principalDeltaPaise: { type: Number, required: true, validate: Number.isInteger },
    interestDeltaPaise: { type: Number, required: true, validate: Number.isInteger },
    feeDeltaPaise: { type: Number, required: true, validate: Number.isInteger },
    
    // Semantic Gross Amount
    amountPaise: { type: Number, required: true, validate: [Number.isInteger, v => v >= 0 && v <= MAX_PAISE] },
    
    // Relational/Audit Pointers
    reversesTransactionId: { type: String, default: null },
    intentId: { type: String, default: null },
    
    // Explicit Structured Accrual Data
    accrualPeriodId: { type: String }, // e.g. "2026-08-29_2026-08-31"
    accrualStart: { type: Date },
    accrualEnd: { type: Date }
});

// Indexes
transactionSchema.index({ loanId: 1, sequenceNumber: 1 }, { unique: true });
transactionSchema.index({ loanId: 1, effectiveAt: 1, sequenceNumber: 1 });
transactionSchema.index({ 'accrualPeriodId': 1, loanId: 1, type: 1 }, { unique: true, sparse: true });

// Immutability Enforcement
// All write-modification and deletion paths are blocked at the Mongoose layer.
// This is defense-in-depth only — the real protection must be Atlas role-level
// (no UPDATE/DELETE on the transactions collection for any app credential).
//
// Hooks covered:
//   updateOne, findOneAndUpdate   — direct single-document update paths
//   deleteOne, findOneAndDelete   — direct single-document deletion paths
//   updateMany                    — batch update (was previously uncovered — discovery L1-E)
//   deleteMany                    — batch deletion (was previously uncovered — discovery L1-F)
//   replaceOne                    — full document replacement (was previously uncovered — discovery L1-G)
//
// Not blockable here: raw driver operations (use Atlas role restrictions for that).
transactionSchema.pre('updateOne',        function() { throw new Error('IMMUTABILITY_VIOLATION: Updates to Transactions are forbidden.'); });
transactionSchema.pre('findOneAndUpdate', function() { throw new Error('IMMUTABILITY_VIOLATION: Updates to Transactions are forbidden.'); });
transactionSchema.pre('updateMany',       function() { throw new Error('IMMUTABILITY_VIOLATION: Batch updates to Transactions are forbidden.'); });
transactionSchema.pre('replaceOne',       function() { throw new Error('IMMUTABILITY_VIOLATION: Replacement of Transactions is forbidden.'); });
transactionSchema.pre('deleteOne',        function() { throw new Error('IMMUTABILITY_VIOLATION: Deletions of Transactions are forbidden.'); });
transactionSchema.pre('findOneAndDelete', function() { throw new Error('IMMUTABILITY_VIOLATION: Deletions of Transactions are forbidden.'); });
transactionSchema.pre('deleteMany',       function() { throw new Error('IMMUTABILITY_VIOLATION: Batch deletions of Transactions are forbidden.'); });


module.exports = mongoose.model('Transaction', transactionSchema);
