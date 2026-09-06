const express = require('express');
const router = express.Router();
const { protectAdmin, requireRole } = require('../middleware/adminAuth');
const {
    getHealthSummary,
    listAlerts,
    acknowledgeAlert,
    getOperationalAuditLog
} = require('../controllers/operationalHealth');

// All operational routes require admin authentication
router.use(protectAdmin);

// Read-only health summary
router.get('/health',
    requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'),
    getHealthSummary
);

// Alert management
router.get('/alerts',
    requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'),
    listAlerts
);

router.post('/alerts/:anomalyType/:identityKey/resolve',
    requireRole('SUPER_ADMIN', 'OPS_ADMIN'),
    acknowledgeAlert
);

// Operational audit trail (read-only)
router.get('/audit-log',
    requireRole('SUPER_ADMIN', 'OPS_ADMIN'),
    getOperationalAuditLog
);

module.exports = router;
