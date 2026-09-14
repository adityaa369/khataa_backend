const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

const newRoutes = `
const { getTestLabStatus, runScenario, cleanupTestRun } = require('../controllers/adminTestLab');
router.get('/testlab/status', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), getTestLabStatus);
router.post('/testlab/run/:scenario', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), requireMFA, runScenario);
router.delete('/testlab/cleanup/:runId', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), requireMFA, cleanupTestRun);
`;

if (!routes.includes('getTestLabStatus')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    fs.writeFileSync(routesPath, routes);
}
