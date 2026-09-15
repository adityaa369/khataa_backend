const mongoose = require('mongoose');

const MPinCredentialSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    firebaseUid: {
        type: String,
        required: true
    },
    mpinHash: {
        type: String,
        required: true
    },
    failedAttempts: {
        type: Number,
        default: 0
    },
    lockoutUntil: {
        type: Date,
        default: null
    }
}, { timestamps: true });

module.exports = mongoose.model('MPinCredential', MPinCredentialSchema);