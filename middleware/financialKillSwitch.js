const { triggerAlert } = require('../utils/telemetry');
const { cacheGet, isRedisAvailable } = require('../config/redis');
const FinancialKillSwitch = require('../models/FinancialKillSwitch');

const isFinancialRoute = (req) => {
    const p = req.path;
    if (req.method === 'GET') return false; 
    if (p.includes('/api/auth') || p.includes('/api/users') || p.includes('/api/admin')) return false; 
    
    if (p.includes('/api/loans') || p.includes('/api/chit') || p.includes('/api/bids')) return true;
    return false;
};

const blockRequest = (req, res, reasonMetadata) => {
    triggerAlert('FINANCIAL_KILL_SWITCH_BLOCKED', 'CRITICAL', { 
        path: req.path, 
        method: req.method, 
        user: req.user ? req.user.id : (req.admin ? req.admin._id : 'unknown'),
        ...reasonMetadata
    });
    return res.status(503).json({
        success: false,
        message: 'Financial operations are temporarily suspended. Your funds are safe. Please try again later.'
    });
};

const financialKillSwitch = async (req, res, next) => {
    if (!isFinancialRoute(req)) return next();

    let isEnabled = false;
    let authSource = 'UNKNOWN';

    try {
        if (isRedisAvailable()) {
            const cachedState = await cacheGet('FINANCIAL_KILL_SWITCH');
            if (cachedState !== null) {
                isEnabled = cachedState === 'true';
                authSource = 'REDIS';
            }
        }

        // If Redis was unavailable or the key was missing (cache miss)
        if (authSource === 'UNKNOWN') {
            const ks = await FinancialKillSwitch.findOne({ key: 'FINANCIAL' }).lean();
            if (ks) {
                isEnabled = ks.enabled;
                authSource = 'MONGODB';
                // Fire and forget cache backfill
                const { cacheSet } = require('../config/redis');
                cacheSet('FINANCIAL_KILL_SWITCH', isEnabled ? 'true' : 'false', 86400).catch(()=>{});
            } else {
                // If model doesn't exist yet, we default to false, but wait, 
                // the user said: "If the system cannot reliably determine the kill-switch state at all, the safer behavior is fail closed".
                // If MongoDB connects but returns null, that means the system is fully healthy but hasn't been initialized yet. We can default to false.
                isEnabled = false;
                authSource = 'MONGODB_DEFAULT';
            }
        }
    } catch (err) {
        console.error('[KillSwitch] FATAL Error reading authoritative state:', err);
        // Fail closed! If we reach here, both Redis failed/missed AND MongoDB threw an error.
        return blockRequest(req, res, { killSwitchState: 'UNKNOWN_FAIL_CLOSED', error: err.message });
    }

    // Explicit Environment override for extreme emergencies (still respected)
    if (process.env.FINANCIAL_KILL_SWITCH === 'true') {
        isEnabled = true;
        authSource = 'ENV';
    }

    if (isEnabled) {
        return blockRequest(req, res, { killSwitchState: 'ACTIVE', authSource });
    }
    
    next();
};

module.exports = financialKillSwitch;
