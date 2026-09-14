const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

const newRoutes = `
const { getCustomerOverview, getCustomers, getCustomerDetail, unmaskKYC } = require('../controllers/adminCustomers');
router.get('/customers/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getCustomerOverview);
router.get('/customers', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getCustomers);
router.get('/customers/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getCustomerDetail);

// STRICT KYC ACCESS ROUTE
router.post('/customers/:id/kyc/unmask', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN'), requireMFA, unmaskKYC);
`;

if (!routes.includes('getCustomerOverview')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    fs.writeFileSync(routesPath, routes);
}
