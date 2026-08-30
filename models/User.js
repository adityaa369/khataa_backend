const mongoose = require('mongoose');
const EncryptionUtil = require('../utils/encryption');

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
    passwordResetToken: {
        type: String,
        select: false
    },
    passwordResetExpires: {
        type: Date,
        select: false
    },
    firebaseUid: {
        type: String,
        sparse: true,
        unique: true,
        index: true,
        select: false  // not sent in API responses
    }
}, { timestamps: true });

// Encrypt highly sensitive PII before saving
UserSchema.pre('save', function(next) {
    if (this.isModified('pan') && this.pan && !this.pan.includes(':')) {
        this.pan = EncryptionUtil.encrypt(this.pan);
    }
    if (this.isModified('aadhar') && this.aadhar && !this.aadhar.includes(':')) {
        this.aadhar = EncryptionUtil.encrypt(this.aadhar);
    }
    next();
});

// Decrypt on retrieve (Helper method, as Mongoose lean() bypasses getters)
UserSchema.methods.getDecryptedKyc = function() {
    return {
        pan: EncryptionUtil.decrypt(this.pan),
        aadhar: EncryptionUtil.decrypt(this.aadhar)
    };
};

UserSchema.set('toJSON', {
    transform: function(doc, ret) {
        delete ret.password;
        delete ret.pan;
        delete ret.aadhar;
        delete ret.fcmToken;
        delete ret.__v;
        delete ret.emailVerificationToken;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpire;
        return ret;
    }
});

UserSchema.set('toObject', {
    transform: function(doc, ret) {
        delete ret.password;
        delete ret.pan;
        delete ret.aadhar;
        delete ret.fcmToken;
        delete ret.__v;
        delete ret.emailVerificationToken;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpire;
        return ret;
    }
});

module.exports = mongoose.model('User', UserSchema);



