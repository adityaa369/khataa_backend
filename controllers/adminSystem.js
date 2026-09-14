const Admin = require('../models/Admin');
const AdminAuditLog = require('../models/AdminAuditLog');
const cacheClient = require('../utils/redisClient');
const { getTraceContext } = require('../utils/asyncContext');

exports.getAdmins = async (req, res) => {
    const admins = await Admin.find().select('-passwordHash -mfaSecret');
    res.status(200).json({ success: true, data: admins });
};

exports.getAuditLogs = async (req, res) => {
    const logs = await AdminAuditLog.find().sort({ createdAt: -1 }).limit(100).populate('adminId', 'email role');
    res.status(200).json({ success: true, data: logs });
};
