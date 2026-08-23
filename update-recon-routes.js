const fs = require('fs');
const path = require('path');
const routesPath = path.join(__dirname, 'routes', 'admin.js');
let routes = fs.readFileSync(routesPath, 'utf8');

const newRoutes = `
const { getReconciliationOverview, getIncidents: getReconIncidents, getIncidentDetail, updateIncidentWorkflow } = require('../controllers/adminReconciliation');
router.get('/reconciliation/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getReconciliationOverview);
router.get('/reconciliation/incidents', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getReconIncidents);
router.get('/reconciliation/incidents/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getIncidentDetail);
router.put('/reconciliation/incidents/:id/workflow', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN'), updateIncidentWorkflow);
`;

if (!routes.includes('getReconciliationOverview')) {
    routes = routes.replace("module.exports = router;", newRoutes + "\nmodule.exports = router;");
    fs.writeFileSync(routesPath, routes);
}
