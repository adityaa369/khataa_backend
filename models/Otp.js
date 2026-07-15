const mongoose = require('mongoose');

const OtpSchema = new mongoose.Schema({
    phone: {
        type: String,
        required: true,
        unique: true
    },
    code: {
        type: String,
        required: true
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expires: '5m' } // auto-delete after 5 minutes
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Otp', OtpSchema);
