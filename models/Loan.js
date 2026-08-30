const mongoose = require('mongoose');

const LoanSchema = new mongoose.Schema({
    lender: {
        type: String, // String to match User.id
        ref: 'User',
        required: true
    },
    borrower: {
        type: String, // String to match User.id
        ref: 'User'
    },
    borrowerName: {
        type: String,
        required: true
    },
    borrowerPhone: {
        type: String,
        required: true
    },
    borrowerAadhar: String,
    borrowerAddress: String,
    amount: { type: Number, required: true },
    amountPaise: { type: Number, validate: { validator: Number.isInteger } },
    transaction_id: {
        type: String,
        unique: true,
        sparse: true
    },
    interestRate: {
        type: Number,
        default: 0
    },
    durationMonths: {
        type: Number,
        required: true
    },
    durationType: {
        type: String,
        enum: ['Days', 'Months', 'Years'],
        default: 'Months'
    },
    status: {
        type: String,
        enum: ['pending_otp', 'pending_approval', 'active', 'completed', 'overdue', 'due_soon', 'defaulted', 'rejected', 'closed'],
        default: 'pending_approval'
    },
    progress: {
        type: Number,
        default: 0
    },
    startDate: Date,
    endDate: Date,
    nextDueDate: Date,
    activatedAt: Date,
    emiAmount: { type: Number, default: 0 },
    emiAmountPaise: { type: Number, validate: { validator: Number.isInteger }, default: 0 },
    totalPayable: { type: Number },
    totalPayablePaise: { type: Number, validate: { validator: Number.isInteger } },
    loanType: {
        type: String,
        default: 'personal' // e.g., 'home', 'business', 'personal'
    },
    otp: String, // OTP for loan agreement
    isOtpVerified: {
        type: Boolean,
        default: false
    },
    documentUrl: {
        type: String,
        required: false
    },
    paidAmount: { type: Number },
    paidAmountPaise: { type: Number, validate: { validator: Number.isInteger } },
    monthsTracking: {
        type: [
            {
                monthIndex: { type: Number, required: true },
                status: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' },
                markedPaidAt: Date,
                markedBy: String
            }
        ],
        default: undefined
    },
    transactions: {
        type: [
            {
                type: {
                    type: String,
                    enum: ['payment', 'interest_payment', 'credit_added', 'loan_given'],
                    required: true
                },
                amount: { type: Number, required: true },
                amountPaise: { type: Number, validate: { validator: Number.isInteger } },
                note: String,
                recordedAt: {
                    type: Date,
                    default: Date.now
                },
                recordedBy: String
            }
        ],
        default: undefined
    },

    // ==========================================
    // V2 ACCOUNTING (MATERIALIZED CACHE)
    // ==========================================
    ledgerVersion: { type: Number, default: 1 }, // Default 1 for legacy loans
    financialStatus: { type: String, enum: ['NORMAL', 'FROZEN'], default: 'NORMAL' },
    
    principalOutstandingPaise: { type: Number, default: 0, validate: [Number.isInteger, v => v >= 0] },
    interestOutstandingPaise: { type: Number, default: 0, validate: [Number.isInteger, v => v >= 0] },
    feesOutstandingPaise: { type: Number, default: 0, validate: [Number.isInteger, v => v >= 0] },
    
    agreementSnapshot: {
        expectedPrincipalPaise: { type: Number },
        interestRateBps: { type: Number },
        interestMethod: { type: String, enum: ['SIMPLE_ORIGINAL_PRINCIPAL', 'NONE'] },
        durationMonths: { type: Number },
        scheduleId: { type: String }
    }
}, {
    timestamps: true,
    toJSON: { 
        virtuals: true,
        transform: function(doc, ret) {
            delete ret.__v;
            return ret;
        }
    },
    toObject: { 
        virtuals: true,
        transform: function(doc, ret) {
            delete ret.__v;
            return ret;
        }
    }
});

LoanSchema.index({ lender: 1, createdAt: -1 });
LoanSchema.index({ borrower: 1, createdAt: -1 });
LoanSchema.index({ borrowerPhone: 1 });

module.exports = mongoose.model('Loan', LoanSchema);

