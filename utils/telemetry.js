const { getTraceContext } = require('./asyncContext');
const SecurityEvent = require('../models/SecurityEvent');
const crypto = require('crypto');

const trackFinancialEvent = (event, payload = {}) => {
    const trace = getTraceContext();
    const { requestId, userId, actorType, ip, path, method } = trace;
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: 'FINANCIAL_EVENT',
        event,
        requestId,
        userId,
        ...payload
    };

    if (process.env.NODE_ENV === 'production') {
        process.stdout.write(JSON.stringify(logEntry) + '\n');
    } else {
        console.log(`[FINANCIAL] ${event} | User: ${userId} | ${JSON.stringify(payload)}`);
    }

    const severityMap = {
        'LOAN_PAYMENT_STARTED': 'MEDIUM',
        'LOAN_PAYMENT_COMMITTED': 'HIGH',
        'LOAN_CREATED': 'HIGH',
        'LOAN_ACCEPTED': 'MEDIUM'
    };

    if (severityMap[event]) {
        try {
            const resolvedActor = (userId && userId !== 'ANONYMOUS') ? userId : (payload.userId || payload.actorId);
            const resolvedRoute = payload.route || payload.path || (method && path ? `${method} ${path}` : path);
            SecurityEvent.create({
                eventId: crypto.randomUUID(),
                eventType: event,
                severity: severityMap[event],
                actorType: resolvedActor ? (actorType && actorType !== 'ANONYMOUS' ? actorType : 'USER') : 'SYSTEM',
                actorId: resolvedActor || 'SYSTEM',
                requestId,
                ipReference: payload.ip || ip || undefined,
                route: resolvedRoute || undefined,
                result: 'SUCCESS',
                financialImpact: event.includes('COMMITTED') || event.includes('CREATED') ? 'COMMITTED' : (event.includes('STARTED') ? 'ATTEMPTED' : 'NONE'),
                reachedFinancialLogic: true,
                metadata: payload
            }).catch(() => {});
        } catch (_) {}
    }
};

const triggerAlert = (alertName, severity, context = {}) => {
    const trace = getTraceContext();
    const { requestId, userId, actorType, ip, path, method, userAgent } = trace;
    const alertEntry = {
        timestamp: new Date().toISOString(),
        type: 'ALERT',
        alertName,
        severity,
        requestId,
        ...context
    };

    if (process.env.NODE_ENV === 'production') {
        process.stdout.write(JSON.stringify(alertEntry) + '\n');
    } else {
        console.error(`\n🔴 [ALERT] [${severity}] ${alertName} | ${JSON.stringify(context)}\n`);
    }

    try {
        let resolvedActorType = context.actorType || (actorType && actorType !== 'ANONYMOUS' ? actorType : 'ANONYMOUS');
        let resolvedActorId = undefined;

        if (context.admin) {
            resolvedActorType = 'ADMIN';
            resolvedActorId = String(context.admin);
        } else if (context.user) {
            resolvedActorType = 'USER';
            resolvedActorId = String(context.user);
        } else if (context.actorId && context.actorId !== 'ANONYMOUS') {
            resolvedActorType = String(context.actorId).startsWith('ADMIN') ? 'ADMIN' : (context.actorType || 'USER');
            resolvedActorId = String(context.actorId);
        } else if (userId && userId !== 'ANONYMOUS') {
            resolvedActorType = String(userId).startsWith('ADMIN') ? 'ADMIN' : (actorType || 'USER');
            resolvedActorId = String(userId);
        }

        let financialImpact = 'NONE';
        let reachedFinancialLogic = false;

        if (alertName === 'OVERPAYMENT_ATTEMPT') {
            financialImpact = 'ATTEMPTED';
            reachedFinancialLogic = true;
        } else if (alertName.includes('FINANCIAL_CORRUPTION') || alertName.includes('MISMATCH')) {
            financialImpact = 'COMMITTED';
            reachedFinancialLogic = true;
        } else if (alertName === 'FINANCIAL_KILL_SWITCH_BLOCKED' || alertName === 'IDEMPOTENCY_REPLAY') {
            financialImpact = 'NONE';
            reachedFinancialLogic = false;
        }

        let result = 'FAILED';
        if (alertName === 'KILL_SWITCH_ACTIVATED' || alertName === 'KILL_SWITCH_DEACTIVATED' || alertName === 'IDEMPOTENCY_REPLAY') result = 'SUCCESS';
        if (alertName.includes('ATTEMPT') || alertName.includes('BLOCKED') || alertName.includes('EXCEEDED')) result = 'BLOCKED';

        const resolvedRoute = context.route || context.path || (method && path ? `${method} ${path}` : path) || undefined;
        const resolvedIp = context.ip || ip || undefined;

        SecurityEvent.create({
            eventId: crypto.randomUUID(),
            eventType: alertName,
            severity,
            actorType: resolvedActorType,
            actorId: resolvedActorId || (resolvedActorType === 'SYSTEM' ? 'SYSTEM' : undefined),
            requestId: context.requestId || requestId,
            ipReference: resolvedIp,
            route: resolvedRoute,
            result,
            financialImpact,
            reachedFinancialLogic,
            resourceType: context.resourceType || undefined,
            resourceId: context.resourceId || undefined,
            metadata: {
                ...context,
                route: resolvedRoute,
                ip: resolvedIp,
                actorId: resolvedActorId,
                userAgent: context.userAgent || userAgent
            }
        }).catch(() => {});
    } catch (_) {}
};

module.exports = { trackFinancialEvent, triggerAlert };
