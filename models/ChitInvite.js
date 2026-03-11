const mongoose = require('mongoose');

const chitInviteSchema = new mongoose.Schema({
    chitFund: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChitFund',
        required: true
    },
    sender: {
        type: String, // Referencing custom user IDs
        ref: 'User',
        required: true
    },
    receiverPhone: {
        type: String,
        required: true
    },
    receiverId: {
        type: String, // Populated if the user exists
        ref: 'User',
        default: null
    },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'declined'],
        default: 'pending'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Compound index to prevent duplicate pending invites
chitInviteSchema.index({ chitFund: 1, receiverPhone: 1 }, { unique: true });

module.exports = mongoose.model('ChitInvite', chitInviteSchema);
