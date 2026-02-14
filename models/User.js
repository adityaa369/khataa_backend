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
    pan: String,
    aadhar: String,
    dob: String,
    gender: String,
    isVerified: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('User', UserSchema);
