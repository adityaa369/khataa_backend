const FinancialKillSwitch = require('../models/FinancialKillSwitch');
const SecurityEvent = require('../models/SecurityEvent');
const Admin = require('../models/Admin');
const speakeasy = require('speakeasy');
const { cacheSet } = require('../config/redis');
const { getTraceContext } = require('../middleware/requestCorrelation');
const { triggerAlert } = require('../utils/telemetry');

// Helper to reliably update Redis
const updateCache = async (isEnabled) => {
    try {
        await cacheSet('FINANCIAL_KILL_SWITCH', isEnabled ? 'true' : 'false', 86400); // 24h
    } catch(e) {
        console.error('[KillSwitch] Redis cache update failed, but MongoDB is authoritative:', e.message);
    }
};

exports.getKillSwitch = async (req, res) => {
    try {
        let ks = await FinancialKillSwitch.findOne({ key: 'FINANCIAL' });
        if (!ks) {
            ks = await FinancialKillSwitch.create({ key: 'FINANCIAL', enabled: false });
        }
        res.status(200).json({ success: true, killSwitch: ks });
    } catch(err) {
        res.status(500).json({ success: false, message: 'Failed to read kill switch state' });
    }
};

const verifyMFA = async (adminId, mfaToken) => {
    if (!mfaToken) return false;
    const admin = await Admin.findById(adminId);
    if (!admin || !admin.mfaSecret) return false; // If no secret, MFA fails (fail closed)
    return speakeasy.totp.verify({
        secret: admin.mfaSecret,
        encoding: 'base32',
        token: mfaToken,
        window: 1 // Allow 30 seconds of skew
    });
};

exports.activateKillSwitch = async (req, res) => {
    const { reason, mfaToken } = req.body;
    const adminId = req.admin._id;

    if (!reason || reason.trim() === '') {
        return res.status(400).json({ success: false, message: 'A mandatory reason is required' });
    }

    const isValidMfa = await verifyMFA(adminId, mfaToken);
    if (!isValidMfa) {
        triggerAlert('ADMIN_MFA_FAILURE', 'HIGH', { action: 'ACTIVATE_KILL_SWITCH', adminId });
        return res.status(403).json({ success: false, message: 'Invalid or missing MFA token' });
    }

    try {
        // Atomic Transition: OFF -> ON
        
        // Ensure doc exists
        await FinancialKillSwitch.updateOne({ key: 'FINANCIAL' }, { $setOnInsert: { enabled: false } }, { upsert: true });
        const ks = await FinancialKillSwitch.findOneAndUpdate(
            { key: 'FINANCIAL', enabled: false },
            { 
                $set: { 
                    enabled: true, 
                    reason: reason.trim(), 
                    activatedBy: adminId, 
                    activatedAt: new Date(), 
                    updatedBy: adminId 
                } 
            },
            { new: true }
        );

        if (!ks) {
            // Already active or document doesn't exist
            const current = await FinancialKillSwitch.findOne({ key: 'FINANCIAL' });
            if (current && current.enabled) {
                return res.status(400).json({ success: false, message: 'Kill switch is already ACTIVE.' });
            }
            return res.status(500).json({ success: false, message: 'Failed to find kill switch state.' });
        }

        // Emit Immutable Audit Event
        triggerAlert('KILL_SWITCH_ACTIVATED', 'CRITICAL', { reason: reason.trim() }, adminId);

        // Update Cache
        await updateCache(true);

        res.status(200).json({ success: true, killSwitch: ks });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

exports.deactivateKillSwitch = async (req, res) => {
    const { reason, mfaToken } = req.body;
    const adminId = req.admin._id;

    if (!reason || reason.trim() === '') {
        return res.status(400).json({ success: false, message: 'A mandatory reason is required' });
    }

    const isValidMfa = await verifyMFA(adminId, mfaToken);
    if (!isValidMfa) {
        triggerAlert('ADMIN_MFA_FAILURE', 'HIGH', { action: 'DEACTIVATE_KILL_SWITCH', adminId });
        return res.status(403).json({ success: false, message: 'Invalid or missing MFA token' });
    }

    try {
        // Atomic Transition: ON -> OFF
        
        // Ensure doc exists
        await FinancialKillSwitch.updateOne({ key: 'FINANCIAL' }, { $setOnInsert: { enabled: false } }, { upsert: true });
        const ks = await FinancialKillSwitch.findOneAndUpdate(
            { key: 'FINANCIAL', enabled: true },
            { 
                $set: { 
                    enabled: false, 
                    reason: reason.trim(), 
                    updatedBy: adminId 
                } 
            },
            { new: true }
        );

        if (!ks) {
            const current = await FinancialKillSwitch.findOne({ key: 'FINANCIAL' });
            if (current && !current.enabled) {
                return res.status(400).json({ success: false, message: 'Kill switch is already OFF.' });
            }
            return res.status(500).json({ success: false, message: 'Failed to find kill switch state.' });
        }

        // Emit Immutable Audit Event
        triggerAlert('KILL_SWITCH_DEACTIVATED', 'HIGH', { reason: reason.trim() }, adminId);

        // Update Cache
        await updateCache(false);

        res.status(200).json({ success: true, killSwitch: ks });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

exports.getHistory = async (req, res) => {
    try {
        const events = await SecurityEvent.find({ 
            eventType: { $in: ['KILL_SWITCH_ACTIVATED', 'KILL_SWITCH_DEACTIVATED'] } 
        }).sort({ createdAt: -1 }).limit(50).lean();
        
        // Populate Admin details if needed, but actorId in SecurityEvent is "ADMIN:<id>"
        res.status(200).json({ success: true, history: events });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch history' });
    }
};


