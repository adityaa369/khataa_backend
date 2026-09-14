const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

const newRoutes = `
const { runAdversarialAudit } = require('../controllers/adminSecurityAudit');
router.post('/security/adversarial-audit', requireRole('SUPER_ADMIN'), requireMFA, runAdversarialAudit);
`;

if (!routes.includes('runAdversarialAudit')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    fs.writeFileSync(routesPath, routes);
}
