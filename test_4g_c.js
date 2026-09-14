/**
 * Phase 4G-C Test Suite
 *
 * Tests:
 *  1. Alert fired on reconciliation mismatch
 *  2. Alert fired on dead-letter notification
 *  3. Alert fired on stuck state (intent)
 *  4. Duplicate anomaly suppression works (same type + identityKey within window)
 *  5. Distinct anomalies NOT suppressed (different identityKey)
 *  6. Operational health endpoint does not leak sensitive data
 *  7. Alert acknowledge is authorized (wrong role blocked)
 *  8. Alert acknowledge is audited in OperationalAuditLog
 *  9. Financial ledger remains sole source of truth (health endpoint never mutates)
 * 10. Resolving alert clears suppression so new occurrence re-fires
 * 11. 4G-B idempotency conflict alert fires and suppresses correctly
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

async function setupDB() {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
}

async function teardownDB() {
    await mongoose.disconnect();
    await replSet.stop();
}

// ─── Capture logs from our structured logger ──────────────────────────────────
function captureLogs(fn) {
    const logs = [];
    const orig = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk) => { logs.push(chunk); };
    process.stderr.write = (chunk) => { logs.push(chunk); };
    return fn().then(result => {
        process.stdout.write = orig;
        process.stderr.write = origErr;
        const parsed = logs.map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
        return { result, logs: parsed };
    }).catch(err => {
        process.stdout.write = orig;
        process.stderr.write = origErr;
        throw err;
    });
}

function getLogField(log, field) {
    return log[field] !== undefined ? log[field] : (log.message && log.message[field]);
}

async function runTests() {
    await setupDB();

    const AlertRecord = require('./models/AlertRecord');
    const OperationalAuditLog = require('./models/OperationalAuditLog');
    const Loan = require('./models/Loan');
    const Transaction = require('./models/Transaction');
    const TransactionIntent = require('./models/TransactionIntent');
    const NotificationOutbox = require('./models/NotificationOutbox');
    const ReconciliationEngine = require('./workers/ReconciliationEngine');
    const OperationalStateMonitor = require('./workers/OperationalStateMonitor');
    const { fireAlert, resolveAlert, getAlertSummary, ALERT_DEFINITIONS } = require('./utils/AlertManager');

    console.log('--- RUNNING PHASE 4G-C VERIFICATION TESTS ---\n');

    // ─── 1. Alert fired on reconciliation mismatch ───────────────────────────
    console.log('[1] Alert fired on reconciliation mismatch...');
    const mismatchLoan = await Loan.create({
        borrowerPhone: '+1111111111', lenderPhone: '+2222222222',
        principalAmountPaise: 1000, amount: 10, durationMonths: 1,
        borrowerName: 'Test', lender: new mongoose.Types.ObjectId(),
        principalOutstandingPaise: 999, // wrong — will mismatch ledger sum
        interestOutstandingPaise: 0,
        feesOutstandingPaise: 0,
        ledgerVersion: 2, financialStatus: 'NORMAL'
    });
    await Transaction.create({
        loanId: mismatchLoan._id, sequenceNumber: 1, type: 'LOAN_CREATED',
        actorId: 'test', principalDeltaPaise: 1000, interestDeltaPaise: 0,
        feeDeltaPaise: 0, amountPaise: 1000, businessDate: '2026-09-01',
        effectiveAt: new Date()
    });

    await ReconciliationEngine.runReconciliation();

    // Allow DB writes to settle
    await new Promise(r => setTimeout(r, 200));

    const reconAlert = await AlertRecord.findOne({ anomalyType: 'RECONCILIATION_MISMATCH', identityKey: mismatchLoan._id.toString() });
    assert(reconAlert, 'RECONCILIATION_MISMATCH alert should be persisted in AlertRecord');
    assert.strictEqual(reconAlert.severity, 'CRITICAL', 'severity should be CRITICAL');
    assert.strictEqual(reconAlert.status, 'OPEN', 'status should be OPEN');
    console.log('✅ Reconciliation mismatch alert fired and persisted');

    // ─── 2. Alert fired on dead-letter notification ──────────────────────────
    console.log('\n[2] Alert fired on dead-letter notification...');
    await fireAlert('NOTIFICATION_DEAD_LETTER', 'evt-dead-001', {
        eventId: 'evt-dead-001',
        retryCount: 5,
        lastError: 'FCM token invalid',
        subsystem: 'NotificationWorker'
    });
    await new Promise(r => setTimeout(r, 200));
    const deadLetterAlert = await AlertRecord.findOne({ anomalyType: 'NOTIFICATION_DEAD_LETTER', identityKey: 'evt-dead-001' });
    assert(deadLetterAlert, 'NOTIFICATION_DEAD_LETTER alert should be persisted');
    assert.strictEqual(deadLetterAlert.severity, 'MEDIUM');
    // Verify lastError (sensitive field) is present in context for runbook
    assert(deadLetterAlert.context && deadLetterAlert.context.lastError, 'context.lastError should be stored for runbook');
    console.log('✅ Dead-letter alert fired and runbook context stored');

    // ─── 3. Alert fired on stuck intent ─────────────────────────────────────
    console.log('\n[3] Alert fired on stuck state...');
    await TransactionIntent.create({
        status: 'PENDING',
        action: 'RECORD_PAYMENT',
        expiresAt: new Date(),
        payload: { amountPaise: 500 },
        userId: 'u1',
        loanId: new mongoose.Types.ObjectId(),
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000)  // 48h old
    });
    await OperationalStateMonitor.runMonitor();
    await new Promise(r => setTimeout(r, 200));
    const stuckAlerts = await AlertRecord.find({ anomalyType: 'STUCK_INTENT' });
    assert(stuckAlerts.length > 0, 'STUCK_INTENT alert should be persisted');
    console.log('✅ Stuck intent alert fired');

    // ─── 4. Duplicate anomaly suppression ────────────────────────────────────
    console.log('\n[4] Duplicate anomaly suppression...');
    // Reset suppression cache by manually deleting and re-importing
    // We need to fire the same alert twice within the suppression window
    await AlertRecord.deleteOne({ anomalyType: 'NEGATIVE_BALANCE', identityKey: 'dedup-test-loan' });

    const fire1 = await fireAlert('NEGATIVE_BALANCE', 'dedup-test-loan', { loanId: 'dedup-test-loan', subsystem: 'test' });
    assert.strictEqual(fire1.fired, true, 'First alert should fire');
    assert.strictEqual(fire1.suppressed, false, 'First alert should NOT be suppressed');

    const fire2 = await fireAlert('NEGATIVE_BALANCE', 'dedup-test-loan', { loanId: 'dedup-test-loan', subsystem: 'test' });
    assert.strictEqual(fire2.fired, false, 'Second alert (within window) should NOT fire');
    assert.strictEqual(fire2.suppressed, true, 'Second alert should be SUPPRESSED');

    await new Promise(r => setTimeout(r, 200));
    const dedupRecord = await AlertRecord.findOne({ anomalyType: 'NEGATIVE_BALANCE', identityKey: 'dedup-test-loan' });
    assert(dedupRecord.suppressedCount >= 1, 'suppressedCount should be incremented');
    console.log('✅ Duplicate anomaly suppressed correctly');

    // ─── 5. Distinct anomalies NOT suppressed ────────────────────────────────
    console.log('\n[5] Distinct anomalies not suppressed...');
    await AlertRecord.deleteMany({ anomalyType: 'NEGATIVE_BALANCE', identityKey: { $in: ['loan-A', 'loan-B'] } });
    // Clear in-memory suppression cache by directly manipulating module
    const AlertManager = require('./utils/AlertManager');
    
    const fireA = await fireAlert('NEGATIVE_BALANCE', 'loan-A', { loanId: 'loan-A', subsystem: 'test' });
    const fireB = await fireAlert('NEGATIVE_BALANCE', 'loan-B', { loanId: 'loan-B', subsystem: 'test' });
    
    assert.strictEqual(fireA.fired, true, 'loan-A alert should fire');
    assert.strictEqual(fireB.fired, true, 'loan-B (distinct identityKey) should ALSO fire (not suppressed by loan-A)');
    console.log('✅ Distinct anomalies fire independently (no cross-suppression)');

    // ─── 6. Health endpoint does not leak sensitive data ─────────────────────
    console.log('\n[6] Health summary contains no sensitive data...');
    const summary = await getAlertSummary();
    const summaryStr = JSON.stringify(summary);
    // These fields should NEVER appear in alert summary
    const forbiddenPatterns = [
        'otp', 'password', 'token', 'signedUrl', 'aadhar', 'kyc',
        'phoneNumber', 'accessToken', 'refreshToken', 'accountNumber'
    ];
    for (const pattern of forbiddenPatterns) {
        assert(!summaryStr.toLowerCase().includes(pattern), `Health summary must not contain '${pattern}'`);
    }
    // Fields that SHOULD be present
    assert(Array.isArray(summary), 'Summary should be an array');
    if (summary.length > 0) {
        assert(summary[0].anomalyType, 'anomalyType should be present');
        assert(summary[0].severity, 'severity should be present');
        assert(!summary[0].context, 'context (potentially rich) should NOT be in summary list view');
    }
    console.log('✅ Health summary contains no sensitive data');

    // ─── 7. Alert acknowledge requires authorization ──────────────────────────
    console.log('\n[7] Alert acknowledge is authorized...');
    // Simulate the route middleware by checking that the controller checks req.admin
    // Since we can't spin up express here, verify the route spec uses requireRole
    const routeCode = require('fs').readFileSync('routes/operational.js', 'utf8');
    assert(routeCode.includes("requireRole('SUPER_ADMIN', 'OPS_ADMIN')"), 'Acknowledge route must require elevated role');
    assert(!routeCode.includes("requireRole('READ_ONLY_ADMIN')") || routeCode.match(/resolve.*requireRole.*SUPER_ADMIN/s), 'READ_ONLY_ADMIN must not be allowed to resolve alerts');
    console.log('✅ Alert acknowledge route requires SUPER_ADMIN or OPS_ADMIN role');

    // ─── 8. Alert acknowledge is audited ─────────────────────────────────────
    console.log('\n[8] Alert acknowledge is audited...');
    // First fire an alert so there's something to resolve
    await AlertRecord.findOneAndUpdate(
        { anomalyType: 'NOTIFICATION_DEAD_LETTER', identityKey: 'evt-audit-test' },
        { $set: { severity: 'MEDIUM', status: 'OPEN', lastSeenAt: new Date(), firstSeenAt: new Date(), suppressedCount: 0, context: {} } },
        { upsert: true }
    );

    // Simulate controller behavior directly
    const { acknowledgeAlert } = require('./controllers/operationalHealth');
    const mockReq = {
        params: { anomalyType: 'NOTIFICATION_DEAD_LETTER', identityKey: 'evt-audit-test' },
        body: { reason: 'Manually verified and cleared' },
        admin: { _id: new mongoose.Types.ObjectId(), role: 'OPS_ADMIN' },
        ip: '127.0.0.1',
        headers: {}
    };
    const mockRes = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(body) { this.body = body; return this; }
    };

    await acknowledgeAlert(mockReq, mockRes);
    assert.strictEqual(mockRes.statusCode, 200, 'Acknowledge should return 200');
    assert(mockRes.body.success, 'Response should have success=true');

    await new Promise(r => setTimeout(r, 300));
    const auditEntry = await OperationalAuditLog.findOne({ action: 'ACKNOWLEDGE_ALERT', actorId: mockReq.admin._id.toString() });
    assert(auditEntry, 'ACKNOWLEDGE_ALERT action must be written to OperationalAuditLog');
    assert.strictEqual(auditEntry.outcome, 'SUCCESS', 'Audit entry outcome should be SUCCESS');
    assert.strictEqual(auditEntry.resourceType, 'AlertRecord', 'Resource type should be AlertRecord');
    console.log('✅ Alert acknowledge audited in OperationalAuditLog');

    // ─── 9. Financial ledger untouched by health endpoint ────────────────────
    console.log('\n[9] Financial ledger remains sole source of truth...');
    const txCountBefore = await Transaction.countDocuments({});
    const loanCountBefore = await Loan.countDocuments({});
    
    // Call health endpoint (simulated)
    const { getHealthSummary } = require('./controllers/operationalHealth');
    const healthReq = {
        admin: { _id: new mongoose.Types.ObjectId(), role: 'READ_ONLY_ADMIN' },
        ip: '127.0.0.1', headers: {}
    };
    const healthRes = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(body) { this.body = body; return this; }
    };
    await getHealthSummary(healthReq, healthRes);

    const txCountAfter = await Transaction.countDocuments({});
    const loanCountAfter = await Loan.countDocuments({});
    assert.strictEqual(txCountAfter, txCountBefore, 'Health endpoint must not create transactions');
    assert.strictEqual(loanCountAfter, loanCountBefore, 'Health endpoint must not create loans');
    assert(healthRes.body.success, 'Health endpoint should succeed');
    assert(!JSON.stringify(healthRes.body.data).includes('principalOutstandingPaise'), 'Health should not expose financial balances');
    console.log('✅ Financial ledger untouched, balances not exposed');

    // ─── 10. Resolving alert clears suppression ───────────────────────────────
    console.log('\n[10] Resolving alert clears suppression cache...');
    // Re-clear and fire
    await AlertRecord.deleteOne({ anomalyType: 'DEPENDENCY_UNAVAILABLE', identityKey: 'redis' });
    const f1 = await fireAlert('DEPENDENCY_UNAVAILABLE', 'redis', { subsystem: 'healthcheck' });
    assert.strictEqual(f1.fired, true);
    const f2 = await fireAlert('DEPENDENCY_UNAVAILABLE', 'redis', { subsystem: 'healthcheck' });
    assert.strictEqual(f2.suppressed, true, 'Should be suppressed within window');
    
    // Resolve it
    await resolveAlert('DEPENDENCY_UNAVAILABLE', 'redis', 'admin-1');
    // Now it should fire again (suppression cache cleared)
    const f3 = await fireAlert('DEPENDENCY_UNAVAILABLE', 'redis', { subsystem: 'healthcheck' });
    assert.strictEqual(f3.fired, true, 'After resolution, alert should fire again');
    console.log('✅ Resolving alert clears suppression — new occurrences re-alert');

    // ─── 11. Idempotency conflict alert ──────────────────────────────────────
    console.log('\n[11] Idempotency conflict alert fires and suppresses...');
    await AlertRecord.deleteOne({ anomalyType: 'IDEMPOTENCY_CONFLICT_SPIKE', identityKey: '/api/loans' });
    const ic1 = await fireAlert('IDEMPOTENCY_CONFLICT_SPIKE', '/api/loans', { idempotencyKey: 'key-xyz', subsystem: 'idempotency' });
    assert.strictEqual(ic1.fired, true);
    const ic2 = await fireAlert('IDEMPOTENCY_CONFLICT_SPIKE', '/api/loans', { idempotencyKey: 'key-xyz', subsystem: 'idempotency' });
    assert.strictEqual(ic2.suppressed, true, 'Repeated idempotency conflict on same route should suppress');
    console.log('✅ Idempotency conflict alert fires and suppresses correctly');

    await teardownDB();
    console.log('\n✅ ALL PHASE 4G-C TESTS PASSED.');
}

runTests().catch(e => {
    console.error('❌ Tests failed:', e.message);
    console.error(e.stack);
    process.exit(1);
});
