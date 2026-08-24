const { getTraceContext } = require('./asyncContext');
const SecurityEvent = require('../models/SecurityEvent');
const crypto = require('crypto');

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

    // Persist as an observability audit event in the background
    // (We treat some financial events as security/audit events if they have impact)
    const severityMap = {
        'LOAN_PAYMENT_STARTED': 'MEDIUM',
        'LOAN_PAYMENT_COMMITTED': 'HIGH',
        'LOAN_CREATED': 'HIGH',
        'LOAN_ACCEPTED': 'MEDIUM'
    };
    
    if (severityMap[event]) {
        try {
            SecurityEvent.create({
                eventId: crypto.randomUUID(),
                eventType: event,
                severity: severityMap[event],
                actorType: userId ? 'USER' : 'SYSTEM',
                actorId: userId,
                requestId,
                result: 'SUCCESS',
                financialImpact: event.includes('COMMITTED') || event.includes('CREATED') ? 'COMMITTED' : (event.includes('STARTED') ? 'ATTEMPTED' : 'NONE'),
                reachedFinancialLogic: true,
                metadata: payload
            }).catch(e => { /* Ignore persistence error to prevent affecting main flow */ });
        } catch(e) {}
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
        console.error(`\n🔴 [ALERT] [${severity}] ${alertName} | ${JSON.stringify(context)}\n`);
    }

    // Persist to SecurityEvent structured store
    try {
        let resolvedActorType = 'ANONYMOUS';
        let resolvedActorId = undefined;

        if (context.admin) {
            resolvedActorType = 'ADMIN';
            resolvedActorId = context.admin;
        } else if (context.user) {
            resolvedActorType = 'USER';
            resolvedActorId = context.user;
        } else if (context.actorId) {
            resolvedActorType = String(context.actorId).startsWith('ADMIN') ? 'ADMIN' : 'USER';
            resolvedActorId = context.actorId;
        }
        let financialImpact = 'NONE';
        let reachedFinancialLogic = false;

        if (alertName === 'OVERPAYMENT_ATTEMPT') {
            financialImpact = 'ATTEMPTED';
            reachedFinancialLogic = true;
        } else if (alertName.includes('FINANCIAL_CORRUPTION') || alertName.includes('MISMATCH')) {
            financialImpact = 'COMMITTED';
            reachedFinancialLogic = true;
        } else if (alertName === 'FINANCIAL_KILL_SWITCH_BLOCKED') {
            financialImpact = 'NONE';
            reachedFinancialLogic = false;
        } else if (alertName === 'IDEMPOTENCY_REPLAY') {
            financialImpact = 'NONE';
            reachedFinancialLogic = false;
        } else if (alertName === 'FINANCIAL_KILL_SWITCH_BLOCKED') {
            financialImpact = 'NONE';
            reachedFinancialLogic = false;
        }

        let result = 'FAILED';
        if (alertName === 'KILL_SWITCH_ACTIVATED' || alertName === 'KILL_SWITCH_DEACTIVATED' || alertName === 'IDEMPOTENCY_REPLAY') result = 'SUCCESS';
        if (alertName.includes('ATTEMPT') || alertName.includes('BLOCKED') || alertName.includes('EXCEEDED')) result = 'BLOCKED';
        
        SecurityEvent.create({
            eventId: crypto.randomUUID(),
            eventType: alertName,
            severity,
            actorType: resolvedActorType,
            actorId: resolvedActorId,
            requestId,
            ipReference: context.ip || undefined,
            route: context.path || undefined,
            result,
            financialImpact,
            reachedFinancialLogic,
            metadata: context
        }).catch(e => {});
    } catch(e) {}
};

module.exports = { trackFinancialEvent, triggerAlert };



