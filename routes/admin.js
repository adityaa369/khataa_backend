const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const adminController = require('../controllers/admin');

router.use(protect, adminOnly); // All admin routes require auth + admin role

router.get('/stats', adminController.getStats);
router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUserDetail);
router.put('/users/:id/suspend', adminController.toggleSuspend);
router.put('/users/:id/role', adminController.setAdminRole);
router.get('/loans', adminController.getLoans);
router.get('/chit-funds', adminController.getChitFunds);


const { getAdmins, getAuditLogs, toggleKillSwitch, getKillSwitchStatus } = require('../controllers/adminSystem');
router.get('/system/admins', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getAdmins);
router.get('/system/audit', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getAuditLogs);

// L-SEC-001 to L-SEC-006: Strict Role & MFA checking for Kill Switch
router.get('/controls/kill-switch', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getKillSwitchStatus);
router.post('/controls/kill-switch', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), requireMFA, toggleKillSwitch);

module.exports = router;
