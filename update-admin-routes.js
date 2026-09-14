const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

const newRoutes = `
const { getFinancialOverview, getTransactions, getLoans } = require('../controllers/admin');
router.get('/financial/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getFinancialOverview);
router.get('/financial/transactions', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getTransactions);
router.get('/financial/loans', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getLoans);
`;

if (!routes.includes('getFinancialOverview')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    
    // Also inject imports to the top if needed, but since it's destructured, we need to modify the existing import
    routes = routes.replace(
        "const { login, getDashboard, getIncidents, updateIncident, toggleKillSwitch } = require('../controllers/admin');",
        "const { login, getDashboard, getIncidents, updateIncident, toggleKillSwitch, getFinancialOverview, getTransactions, getLoans } = require('../controllers/admin');"
    );
    // actually, let's just use the above `require('../controllers/admin')` directly inside newRoutes instead of fighting regex.
    fs.writeFileSync(routesPath, routes);
}
