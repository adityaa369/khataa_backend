const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const User = require('../models/User');
const AdminAuditLog = require('../models/AdminAuditLog');
const { getTraceContext } = require('../utils/asyncContext');

const protectAdmin = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ success: false, message: 'Not authorized, no admin token' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Case 1: Dedicated Admin Control Plane JWT (has adminId + role)
        if (decoded.adminId && decoded.role) {
            const admin = await Admin.findById(decoded.adminId);
            if (!admin || !admin.isActive) {
                return res.status(401).json({ success: false, message: 'Admin deactivated or not found' });
            }
            req.admin = admin;
            req.adminSession = decoded;

            const store = require('../utils/asyncContext').asyncLocalStorage.getStore();
            if (store) store.userId = `ADMIN:${admin._id}`;
            return next();
        }

        // Case 2: Mobile User JWT where user.isAdmin === true
        if (decoded.id) {
            const user = await User.findOne({ id: decoded.id });
            if (!user || !user.isAdmin || user.isSuspended) {
                return res.status(403).json({ success: false, message: 'Admin privileges required' });
            }
            req.user = user;
            req.admin = {
                _id: user._id,
                email: user.email || `${user.phone}@handcredit.in`,
                role: 'SUPER_ADMIN',
                mfaEnabled: false,
                isActive: true
            };
            req.adminSession = {
                adminId: user._id,
                role: 'SUPER_ADMIN',
                mfaVerified: true
            };

            const store = require('../utils/asyncContext').asyncLocalStorage.getStore();
            if (store) store.userId = `ADMIN:${user._id}`;
            return next();
        }

        return res.status(403).json({ success: false, message: 'Invalid admin token' });
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Admin token failed or expired' });
    }
};

const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.admin || !roles.includes(req.admin.role)) {
            return res.status(403).json({ success: false, message: `Role ${req.admin ? req.admin.role : 'UNKNOWN'} is not authorized to access this route` });
        }
        next();
    };
};

const requireMFA = (req, res, next) => {
    const isHighRisk = ['SUPER_ADMIN', 'OPS_ADMIN'].includes(req.admin.role);
    if (isHighRisk && !req.adminSession.mfaVerified) {
        return res.status(403).json({ success: false, message: 'MFA verification strictly required for high-risk administrative roles' });
    }
    if (req.admin.mfaEnabled && !req.adminSession.mfaVerified) {
        return res.status(403).json({ success: false, message: 'MFA verification required for this operation' });
    }
    next();
};

const logAdminAction = async (adminId, action, reason, status, req, resourceType = null, resourceId = null, details = {}) => {
    try {
        const { requestId } = getTraceContext();
        await AdminAuditLog.create({
            adminId,
            action,
            reason,
            status,
            ipAddress: req.ip,
            requestId,
            resourceType,
            resourceId,
            details
        });
    } catch (err) {
        console.error('[AdminAuditLog] Failed to record audit log:', err.message);
    }
};

module.exports = { protectAdmin, requireRole, requireMFA, logAdminAction };
