require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('./utils/logger');
const { fireAlert } = require('./utils/AlertManager');

const InterestAccrualWorker = require('./workers/InterestAccrualWorker');
const NotificationWorker = require('./workers/NotificationWorker');
const ReconciliationEngine = require('./workers/ReconciliationEngine');
const OperationalStateMonitor = require('./workers/OperationalStateMonitor');

let isRunning = { interest: false, notification: false, reconciliation: false, monitor: false };
const intervals = [];

async function connectDB() {
    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(process.env.MONGODB_URI);
            logger.info('[Scheduler] MongoDB Connected');
        }
    } catch (err) {
        logger.error('[Scheduler] MongoDB Connection Error: ' + err.message);
        fireAlert('DEPENDENCY_UNAVAILABLE', 'CRITICAL', 'mongodb', { error: err.message, subsystem: 'scheduler' });
        process.exit(1);
    }
}

async function runInterestAccrualSafe() {
    if (isRunning.interest) return;
    isRunning.interest = true;
    try {
        const today = new Date();
        logger.info(`[Scheduler] Triggering InterestAccrualWorker for ${today.toISOString()}`);
        const result = await InterestAccrualWorker.runDailyAccrual(today);
        logger.info(`[Scheduler] InterestAccrualWorker completed: ${JSON.stringify(result)}`);
    } catch (e) {
        logger.error(`[Scheduler] InterestAccrualWorker failed: ${e.message}`);
        fireAlert('WORKER_FAILED', 'HIGH', 'InterestAccrualWorker', { error: e.message, subsystem: 'scheduler' });
    } finally {
        isRunning.interest = false;
    }
}

async function runNotificationSafe() {
    if (isRunning.notification) return;
    isRunning.notification = true;
    try {
        await NotificationWorker.processOutbox();
    } catch (e) {
        logger.error(`[Scheduler] NotificationWorker failed: ${e.message}`);
        fireAlert('WORKER_FAILED', 'MEDIUM', 'NotificationWorker', { error: e.message, subsystem: 'scheduler' });
    } finally {
        isRunning.notification = false;
    }
}

async function runReconciliationSafe() {
    if (isRunning.reconciliation) return;
    isRunning.reconciliation = true;
    try {
        logger.info('[Scheduler] Triggering ReconciliationEngine');
        const result = await ReconciliationEngine.runReconciliation();
        logger.info(`[Scheduler] ReconciliationEngine completed: ${JSON.stringify(result)}`);
    } catch (e) {
        logger.error(`[Scheduler] ReconciliationEngine failed: ${e.message}`);
        fireAlert('WORKER_FAILED', 'HIGH', 'ReconciliationEngine', { error: e.message, subsystem: 'scheduler' });
    } finally {
        isRunning.reconciliation = false;
    }
}

async function runMonitorSafe() {
    if (isRunning.monitor) return;
    isRunning.monitor = true;
    try {
        await OperationalStateMonitor.runMonitor();
    } catch (e) {
        logger.error(`[Scheduler] OperationalStateMonitor failed: ${e.message}`);
        fireAlert('WORKER_FAILED', 'HIGH', 'OperationalStateMonitor', { error: e.message, subsystem: 'scheduler' });
    } finally {
        isRunning.monitor = false;
    }
}

async function start() {
    logger.info('[Scheduler] Starting Khataa Production Scheduler (Singleton)');
    await connectDB();
    
    // Interest Accrual: Idempotent hourly check
    intervals.push(setInterval(runInterestAccrualSafe, 60 * 60 * 1000));
    // Notifications: 30 seconds
    intervals.push(setInterval(runNotificationSafe, 30 * 1000));
    // Reconciliation: Hourly check
    intervals.push(setInterval(runReconciliationSafe, 60 * 60 * 1000));
    // Operational Monitor: 5 minutes
    intervals.push(setInterval(runMonitorSafe, 5 * 60 * 1000));

    logger.info('[Scheduler] All schedules registered. Running initial ticks...');
    await runInterestAccrualSafe();
    await runReconciliationSafe();
    await runMonitorSafe();
    await runNotificationSafe();
}

start();

process.on('SIGTERM', () => {
    logger.info('[Scheduler] Received SIGTERM, shutting down...');
    intervals.forEach(clearInterval);
    mongoose.connection.close().then(() => process.exit(0));
});
