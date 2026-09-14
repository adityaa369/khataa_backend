const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

const newRoutes = `
const { getProductionReadiness } = require('../controllers/adminReadiness');
router.get('/system/readiness', requireRole('SUPER_ADMIN'), requireMFA, getProductionReadiness);
`;

if (!routes.includes('getProductionReadiness')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    fs.writeFileSync(routesPath, routes);
}
