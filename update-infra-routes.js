const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

const newRoutes = `
const { getInfraOverview, getDisasterRecoveryStatus } = require('../controllers/adminInfra');
router.get('/infra/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'READ_ONLY_ADMIN'), getInfraOverview);
router.get('/infra/dr', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'READ_ONLY_ADMIN'), getDisasterRecoveryStatus);
`;

if (!routes.includes('getInfraOverview')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    fs.writeFileSync(routesPath, routes);
}
