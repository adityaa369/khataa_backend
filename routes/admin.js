const express = require('express');
const router = express.Router();
const { protectAdmin, requireRole, requireMFA } = require('../middleware/adminAuth');
const { login, getDashboard, getIncidents, updateIncident, getFinancialOverview, getTransactions, getLoans } = require('../controllers/admin');

router.post('/auth/login', login);

router.use(protectAdmin); // All routes below require Admin JWT

router.get('/dashboard', requireMFA, getDashboard);
router.get('/incidents', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getIncidents);
router.put('/incidents/:id/status', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN'), updateIncident);


router.get('/financial/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getFinancialOverview);
router.get('/financial/transactions', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getTransactions);
router.get('/financial/loans/list', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getLoans);


const { getChitOverview, getChits, getChitDetail } = require('../controllers/adminChits');
router.get('/chits/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getChitOverview);
router.get('/chits', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getChits);
router.get('/chits/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getChitDetail);


const { getCustomerOverview, getCustomers, getCustomerDetail, unmaskKYC } = require('../controllers/adminCustomers');
router.get('/customers/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getCustomerOverview);
router.get('/customers', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getCustomers);
router.get('/customers/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getCustomerDetail);

// STRICT KYC ACCESS ROUTE
router.post('/customers/:id/kyc/unmask', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN'), requireMFA, unmaskKYC);


const { getSecurityOverview, getSecurityEvents, investigateSecurityEvents } = require('../controllers/adminSecurity');
router.get('/security/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getSecurityOverview);
router.get('/security/events', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getSecurityEvents);
router.get('/security/investigate', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), investigateSecurityEvents);


const { getReconciliationOverview, getIncidents: getReconIncidents, getIncidentDetail, updateIncidentWorkflow } = require('../controllers/adminReconciliation');
router.get('/reconciliation/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getReconciliationOverview);
router.get('/reconciliation/incidents', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getReconIncidents);
router.get('/reconciliation/incidents/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getIncidentDetail);
router.put('/reconciliation/incidents/:id/workflow', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN'), updateIncidentWorkflow);


const { getInfraOverview, getDisasterRecoveryStatus } = require('../controllers/adminInfra');
router.get('/infra/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'READ_ONLY_ADMIN'), getInfraOverview);
router.get('/infra/dr', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'READ_ONLY_ADMIN'), getDisasterRecoveryStatus);


const { getAdmins, getAuditLogs, toggleKillSwitch, getKillSwitchStatus } = require('../controllers/adminSystem');
router.get('/system/admins', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getAdmins);
router.get('/system/audit', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getAuditLogs);

const { getPaymentsOverview, getLoansOverview, getLedgerReconciliation, getIdempotencyMetrics } = require('../controllers/adminFinancialExplorer');
const { getKillSwitch, activateKillSwitch, deactivateKillSwitch, getHistory } = require('../controllers/adminKillSwitch');
router.get('/kill-switch', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getKillSwitch);
router.post('/kill-switch/activate', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), activateKillSwitch);
router.post('/kill-switch/deactivate', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), deactivateKillSwitch);
router.get('/kill-switch/history', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getHistory);


const { getTestLabStatus, runScenario, cleanupTestRun } = require('../controllers/adminTestLab');
router.get('/testlab/status', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), getTestLabStatus);
router.post('/testlab/run/:scenario', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), requireMFA, runScenario);
router.delete('/testlab/cleanup/:runId', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), requireMFA, cleanupTestRun);


const { runAdversarialAudit } = require('../controllers/adminSecurityAudit');
router.post('/security/adversarial-audit', requireRole('SUPER_ADMIN'), requireMFA, runAdversarialAudit);


const { getProductionReadiness } = require('../controllers/adminReadiness');
router.get('/system/readiness', requireRole('SUPER_ADMIN'), requireMFA, getProductionReadiness);


// E.7 Financial Explorer (Read-Only)
router.get('/financial/payments', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getPaymentsOverview);
router.get('/financial/loans', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getLoansOverview);
router.get('/financial/ledger', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getLedgerReconciliation);
router.get('/financial/idempotency', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getIdempotencyMetrics);

module.exports = router;




