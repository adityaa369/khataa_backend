// utils/telemetry.js
const { getTraceContext } = require('./asyncContext');

const trackFinancialEvent = (event, payload) => {
    const { requestId, userId } = getTraceContext();
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: 'FINANCIAL_EVENT',
        event,
        requestId,
        userId,
        ...payload
    };
    
    // In production, emit as pure JSON for Datadog/ELK
    if (process.env.NODE_ENV === 'production') {
        process.stdout.write(JSON.stringify(logEntry) + '\n');
    } else {
        console.log(`[FINANCIAL] ${event} | User: ${userId} | ${JSON.stringify(payload)}`);
    }
};

const triggerAlert = (alertName, severity, context) => {
    const { requestId } = getTraceContext();
    const alertEntry = {
        timestamp: new Date().toISOString(),
        type: 'ALERT',
        alertName,
        severity, // e.g. 'CRITICAL', 'HIGH'
        requestId,
        ...context
    };
    
    if (process.env.NODE_ENV === 'production') {
        process.stdout.write(JSON.stringify(alertEntry) + '\n');
    } else {
        console.error(`\n?? [ALERT] [${severity}] ${alertName} | ${JSON.stringify(context)}\n`);
    }
};

module.exports = { trackFinancialEvent, triggerAlert };
