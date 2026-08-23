const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

const newRoutes = `
const { getSecurityOverview, getSecurityEvents } = require('../controllers/adminSecurity');
router.get('/security/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getSecurityOverview);
router.get('/security/events', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getSecurityEvents);
`;

if (!routes.includes('getSecurityOverview')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    fs.writeFileSync(routesPath, routes);
}
