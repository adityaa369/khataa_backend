const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const AdminSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    role: { 
        type: String, 
        enum: ['SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'], 
        required: true 
    },
    mfaSecret: { type: String },
    mfaEnabled: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date }
}, { timestamps: true });

AdminSchema.methods.comparePassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.passwordHash);
};

module.exports = mongoose.model('Admin', AdminSchema);
