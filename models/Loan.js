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
    amount: {
        type: Number,
        required: true
    },
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
    emiAmount: {
        type: Number,
        default: 0
    },
    totalPayable: {
        type: Number,
        default: 0
    },
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
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Loan', LoanSchema);
