const { triggerAlert } = require('../utils/telemetry');
const { cacheGet } = require('../config/redis');

const isFinancialRoute = (req) => {
    const p = req.path;
    if (req.method === 'GET') return false; 
    if (p.includes('/api/auth') || p.includes('/api/users') || p.includes('/api/admin')) return false; 
    
    if (p.includes('/api/loans') || p.includes('/api/chit') || p.includes('/api/bids')) return true;
    return false;
};

const financialKillSwitch = async (req, res, next) => {
    try {
        const killSwitchState = await cacheGet('FINANCIAL_KILL_SWITCH');
        // Fallback to ENV if Redis is unavailable or explicitly set in ENV
        const isEnabled = killSwitchState === 'true' || process.env.FINANCIAL_KILL_SWITCH === 'true';

        if (isEnabled && isFinancialRoute(req)) {
            triggerAlert('FINANCIAL_KILL_SWITCH_BLOCKED', 'CRITICAL', { path: req.path, method: req.method, user: req.user ? req.user.id : (req.admin ? req.admin._id : 'unknown') });
            return res.status(503).json({
                success: false,
                message: 'Financial operations are temporarily suspended for maintenance or reconciliation. Your funds are safe. Please try again later.'
            });
        }
        next();
    } catch (err) {
        console.error('[KillSwitch] Error reading state:', err);
        next(); // Fail open if Redis drops, or handle gracefully based on policy
    }
};

module.exports = financialKillSwitch;
