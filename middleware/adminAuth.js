const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
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
        
        // Strict boundary: The token MUST have an admin role
        if (!decoded.role || !decoded.adminId) {
            return res.status(403).json({ success: false, message: 'Invalid admin token' });
        }

        const admin = await Admin.findById(decoded.adminId);
        if (!admin || !admin.isActive) {
            return res.status(401).json({ success: false, message: 'Admin deactivated or not found' });
        }

        req.admin = admin;
        req.adminSession = decoded;

        // Inject into async context for logging
        const store = require('../utils/asyncContext').asyncLocalStorage.getStore();
        if (store) store.userId = `ADMIN:${admin._id}`;

        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Admin token failed' });
    }
};

const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.admin.role)) {
            return res.status(403).json({ success: false, message: `Role ${req.admin.role} is not authorized to access this route` });
        }
        next();
    };
};

const requireMFA = (req, res, next) => {
    if (req.admin.mfaEnabled && !req.adminSession.mfaVerified) {
        return res.status(403).json({ success: false, message: 'MFA verification required for this operation' });
    }
    next();
};

const logAdminAction = async (adminId, action, reason, status, req, resourceType = null, resourceId = null, details = {}) => {
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
};

module.exports = { protectAdmin, requireRole, requireMFA, logAdminAction };
