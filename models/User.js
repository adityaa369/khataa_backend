const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true
    },
    firstName: {
        type: String,
        required: false
    },
    lastName: {
        type: String,
        required: false
    },
    phone: {
        type: String,
        required: true,
        unique: true
    },
    email: {
        type: String,
        sparse: true
    },
    city: String,
    address: String,
    password: {
        type: String,
        select: false,
        required: false
    },
    pan: String,
    aadhar: String,
    dob: String,
    gender: String,
    isVerified: {
        type: Boolean,
        default: false
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    isSuspended: {
        type: Boolean,
        default: false
    },
    isEmailVerified: {
        type: Boolean,
        default: false
    },
    emailVerificationToken: {
        type: String,
        select: false
    },
    emailVerificationExpires: Date,
    fcmToken: {
        type: String,
        required: false
    },
    firebaseUid: {
        type: String,
        required: false
    },
    // Notification preferences — persisted server-side for cross-device sync
    notificationPreferences: {
        loanUpdates:    { type: Boolean, default: true },   // TRANSACTIONAL
        paymentUpdates: { type: Boolean, default: true },   // TRANSACTIONAL
        securityAlerts: { type: Boolean, default: true },   // MANDATORY — cannot disable
        kycUpdates:     { type: Boolean, default: true },   // TRANSACTIONAL
        chitFundUpdates:{ type: Boolean, default: true },
        promotional:    { type: Boolean, default: false }   // OPTIONAL
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('User', UserSchema);
