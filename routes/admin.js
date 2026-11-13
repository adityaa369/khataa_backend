const express = require('express');
const router = express.Router();
const { protectAdmin, requireRole, requireMFA } = require('../middleware/adminAuth');
const {
    login,
    getDashboard,
    getLatencyAndUserIssues,
    getApiFailuresDashboard,
    clearStaleTelemetry,
    triggerKeepAlivePing,
    getDatabaseCollections,
    previewDataQuery,
    purgeUserData,
    deleteUserAdmin,
    getIncidents,
    updateIncident,
    toggleKillSwitch,
    getFinancialOverview,
    getTransactions,
    getLoans,
    getStats,
    getUsers,
    getUserDetail,
    toggleSuspend,
    verifyUserEmailAdmin,
    setAdminRole,
    getChitFunds
} = require('../controllers/admin');

// Public Admin Login
router.post('/auth/login', login);

// All routes below require Admin JWT (or mobile User JWT with isAdmin === true)
router.use(protectAdmin);

// ─── V1 Mobile-Compatible & Core Admin Routes ───────────────────────────────
router.get('/stats', getStats);
router.get('/users', getUsers);
router.get('/users/:id', getUserDetail);
router.put('/users/:id/suspend', toggleSuspend);
router.put('/users/:id/verify-email', verifyUserEmailAdmin);
router.put('/users/:id/role', setAdminRole);
router.delete('/users/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), deleteUserAdmin);
router.get('/loans', getLoans);
router.get('/chit-funds', getChitFunds);

// ─── V2 Production Operations Dashboard Routes ──────────────────────────────
router.get('/dashboard', requireMFA, getDashboard);
router.get('/incidents', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getIncidents);
router.put('/incidents/:id/status', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN'), updateIncident);

// ─── Observability Dashboards (Latency/User Issues & API Failures/Traces) ───
router.get('/observability/latency-errors', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getLatencyAndUserIssues);
router.get('/observability/api-failures', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getApiFailuresDashboard);
router.post('/observability/clear-telemetry', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), clearStaleTelemetry);
router.post('/observability/keep-alive/ping', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'READ_ONLY_ADMIN'), triggerKeepAlivePing);

// ─── Live User Data Query & Purge Studio (Preserves Schema & Indexes) ───────
router.get('/data/collections', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'READ_ONLY_ADMIN'), getDatabaseCollections);
router.post('/data/query-preview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), previewDataQuery);
router.post('/data/purge', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), requireMFA, purgeUserData);

// Financial Command Center & Explorer
router.get('/financial/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getFinancialOverview);
router.get('/financial/transactions', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getTransactions);
router.get('/financial/loans/list', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getLoans);

const { getPaymentsOverview, getLoansOverview, getLedgerReconciliation, getIdempotencyMetrics } = require('../controllers/adminFinancialExplorer');
router.get('/financial/payments', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getPaymentsOverview);
router.get('/financial/loans', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getLoansOverview);
router.get('/financial/ledger', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getLedgerReconciliation);
router.get('/financial/idempotency', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getIdempotencyMetrics);

// Chit Operations
const { getChitOverview, getChits, getChitDetail } = require('../controllers/adminChits');
router.get('/chits/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getChitOverview);
router.get('/chits', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getChits);
router.get('/chits/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getChitDetail);

// Customer 360 & Account Controls
const { getCustomerOverview, getCustomers, getCustomerDetail, unmaskKYC, resetAadhaarKycAdmin } = require('../controllers/adminCustomers');
router.get('/customers/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getCustomerOverview);
router.get('/customers', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getCustomers);
router.get('/customers/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getCustomerDetail);
router.put('/customers/:id/suspend', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN'), toggleSuspend);
router.put('/customers/:id/verify-email', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN'), verifyUserEmailAdmin);
router.put('/customers/:id/reset-aadhaar', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN'), resetAadhaarKycAdmin);
router.post('/customers/:id/kyc/unmask', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN'), requireMFA, unmaskKYC);
router.delete('/customers/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), deleteUserAdmin);

// Security Telemetry & Incident Investigation
const { getSecurityOverview, getSecurityEvents, investigateSecurityEvents } = require('../controllers/adminSecurity');
router.get('/security/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getSecurityOverview);
router.get('/security/events', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getSecurityEvents);
router.get('/security/investigate', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), investigateSecurityEvents);

// Reconciliation Command Center
const { getReconciliationOverview, getIncidents: getReconIncidents, getIncidentDetail, updateIncidentWorkflow } = require('../controllers/adminReconciliation');
router.get('/reconciliation/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getReconciliationOverview);
router.get('/reconciliation/incidents', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getReconIncidents);
router.get('/reconciliation/incidents/:id', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getIncidentDetail);
router.put('/reconciliation/incidents/:id/workflow', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN'), updateIncidentWorkflow);

// Infrastructure & Disaster Recovery
const { getInfraOverview, getDisasterRecoveryStatus } = require('../controllers/adminInfra');
router.get('/infra/overview', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'READ_ONLY_ADMIN'), getInfraOverview);
router.get('/infra/dr', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'READ_ONLY_ADMIN'), getDisasterRecoveryStatus);

// System & Audit Logs
const { getAdmins, getAuditLogs } = require('../controllers/adminSystem');
router.get('/system/admins', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getAdmins);
router.get('/system/audit', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'READ_ONLY_ADMIN'), getAuditLogs);

// Financial Emergency Kill Switch (including /controls/kill-switch aliases)
const { getKillSwitch, activateKillSwitch, deactivateKillSwitch, getHistory } = require('../controllers/adminKillSwitch');
router.get('/kill-switch', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getKillSwitch);
router.post('/kill-switch/activate', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), activateKillSwitch);
router.post('/kill-switch/deactivate', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), deactivateKillSwitch);
router.post('/kill-switch/toggle', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), toggleKillSwitch);
router.get('/kill-switch/history', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getHistory);

router.get('/controls/kill-switch', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getKillSwitch);
router.post('/controls/kill-switch/activate', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), activateKillSwitch);
router.post('/controls/kill-switch/deactivate', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), deactivateKillSwitch);
router.get('/controls/kill-switch/history', requireRole('SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'), getHistory);

// Test Lab, Adversarial Audit & Production Readiness Gates
const { getTestLabStatus, runScenario, cleanupTestRun } = require('../controllers/adminTestLab');
router.get('/testlab/status', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), getTestLabStatus);
router.post('/testlab/run/:scenario', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), requireMFA, runScenario);
router.delete('/testlab/cleanup/:runId', requireRole('SUPER_ADMIN', 'OPS_ADMIN'), requireMFA, cleanupTestRun);

const { runAdversarialAudit } = require('../controllers/adminSecurityAudit');
router.post('/security/adversarial-audit', requireRole('SUPER_ADMIN'), requireMFA, runAdversarialAudit);

const { getProductionReadiness } = require('../controllers/adminReadiness');
router.get('/system/readiness', requireRole('SUPER_ADMIN'), requireMFA, getProductionReadiness);

module.exports = router;
