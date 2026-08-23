const Admin = require('../models/Admin');
const AdminAuditLog = require('../models/AdminAuditLog');
const { getCacheClient } = require('../utils/cache');
const { getTraceContext } = require('../utils/asyncContext');

exports.getAdmins = async (req, res) => {
    const admins = await Admin.find().select('-passwordHash -mfaSecret');
    res.status(200).json({ success: true, data: admins });
};

exports.getAuditLogs = async (req, res) => {
    const logs = await AdminAuditLog.find().sort({ createdAt: -1 }).limit(100).populate('adminId', 'email role');
    res.status(200).json({ success: true, data: logs });
};

exports.toggleKillSwitch = async (req, res) => {
    const { enable, reason } = req.body;
    
    // Constraint L-SEC-007, 008
    if (!reason || reason.trim() === '') {
        return res.status(400).json({ success: false, message: 'A mandatory reason is required to modify the kill switch state.' });
    }

    const cacheClient = getCacheClient();
    const currentState = await cacheClient.get('FINANCIAL_KILL_SWITCH') === 'true';

    // Prevent Replay or redundant actions
    if (currentState === enable) {
        return res.status(400).json({ success: false, message: `Kill switch is already ${enable ? 'enabled' : 'disabled'}.` });
    }

    // Toggle
    await cacheClient.set('FINANCIAL_KILL_SWITCH', enable ? 'true' : 'false');

    // Immutable Audit Log
    const { requestId } = getTraceContext();
    await AdminAuditLog.create({
        adminId: req.admin._id,
        action: enable ? 'ENABLE_KILL_SWITCH' : 'DISABLE_KILL_SWITCH',
        reason: reason,
        status: 'SUCCESS',
        ipAddress: req.ip,
        requestId,
        resourceType: 'SystemControl',
        resourceId: 'FINANCIAL_KILL_SWITCH'
    });

    res.status(200).json({ success: true, killSwitchEnabled: enable });
};

exports.getKillSwitchStatus = async (req, res) => {
    const cacheClient = getCacheClient();
    const currentState = await cacheClient.get('FINANCIAL_KILL_SWITCH') === 'true';
    res.status(200).json({ success: true, killSwitchEnabled: currentState });
}
