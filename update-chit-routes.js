const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

const newRoutes = `
const { getChitOverview, getChits, getChitDetail } = require('../controllers/adminChits');
router.get('/chits/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getChitOverview);
router.get('/chits', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getChits);
router.get('/chits/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getChitDetail);
`;

if (!routes.includes('getChitOverview')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    fs.writeFileSync(routesPath, routes);
}
