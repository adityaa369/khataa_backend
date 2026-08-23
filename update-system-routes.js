const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

// Replace the old toggleKillSwitch import/route
routes = routes.replace("const { login, getDashboard, getIncidents, updateIncident, toggleKillSwitch, getFinancialOverview", "const { login, getDashboard, getIncidents, updateIncident, getFinancialOverview");
routes = routes.replace("router.post('/controls/kill-switch', requireRole('SUPER_ADMIN'), requireMFA, toggleKillSwitch);", "");

const newRoutes = `
const { getAdmins, getAuditLogs, toggleKillSwitch, getKillSwitchStatus } = require('../controllers/adminSystem');
router.get('/system/admins', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getAdmins);
router.get('/system/audit', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getAuditLogs);

// L-SEC-001 to L-SEC-006: Strict Role & MFA checking for Kill Switch
router.get('/controls/kill-switch', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getKillSwitchStatus);
router.post('/controls/kill-switch', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), requireMFA, toggleKillSwitch);
`;

if (!routes.includes('getAdmins')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    fs.writeFileSync(routesPath, routes);
}
