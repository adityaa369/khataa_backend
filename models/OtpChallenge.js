const mongoose = require('mongoose');

const OtpChallengeSchema = new mongoose.Schema({
    // We can use Firebase's verificationId as the primary challengeId since it uniquely identifies the OTP session
    challengeId: {
        type: String,
        required: true,
        unique: true
    },
    userId: {
        type: String,
        ref: 'User',
        required: true,
        index: true
    },
    purpose: {
        type: String,
        enum: ['LOGIN', 'LOAN_ACCEPTANCE', 'LOAN_PAYMENT', 'LOAN_CLOSURE', 'KYC_VERIFICATION'],
        required: true
    },
    resourceId: {
        type: mongoose.Schema.Types.ObjectId,
        required: false // E.g., Loan ID
    },
    expectedAmountPaise: {
        type: Number,
        required: false // For strict financial binding
    },
    status: {
        type: String,
        enum: ['PENDING', 'CONSUMED', 'FAILED'],
        default: 'PENDING'
    },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 15 * 60 * 1000), // 15 mins max TTL
        index: { expires: '1s' }
    }
}, { timestamps: true });

module.exports = mongoose.model('OtpChallenge', OtpChallengeSchema);
