// middleware/metrics.js
const crypto = require('crypto');
const { triggerAlert } = require('../utils/telemetry');
const { getTraceContext } = require('../utils/asyncContext');

const MAX_FAILURE_TRACES = 200;
const MAX_SLOW_TRACES = 200;
const SLOW_REQUEST_THRESHOLD_MS = 250;

const metrics = {
    startedAt: new Date().toISOString(),
    requests: {
        total: 0,
        active: 0,
        '2xx': 0,
        '4xx': 0,
        '5xx': 0
    },
    latencies: [],
    routeBreakdown: {},
    apiFailures: [],
    slowRequests: [],
    recent5xxTimestamps: [],
    financial: {
        paymentsAttempted: 0,
        paymentsCommitted: 0,
        paymentsRejected: 0,
        idempotencyReplays: 0,
        transactionAborts: 0
    }
};

function normalizeRoute(req) {
    const rawPath = (req.originalUrl || req.url || '/').split('?')[0];
    // Replace Mongo ObjectIds and UUIDs with :id for clean route grouping
    return rawPath
        .replace(/\/[0-9a-fA-F]{24}(?=\/|$)/g, '/:id')
        .replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g, '/:uuid')
        .replace(/\/intent_[0-9a-fA-F-]+(?=\/|$)/g, '/:intentId');
}

const recordLatency = (durationMs) => {
    const rounded = Math.round(durationMs * 100) / 100;
    metrics.latencies.push(rounded);
    if (metrics.latencies.length > 1000) metrics.latencies.shift();
};

const calculatePercentileFromArray = (arr, p) => {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * (p / 100);
    const base = Math.floor(pos);
    const rest = pos - base;
    const val = sorted[base + 1] !== undefined
        ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
        : sorted[base];
    return Math.round(val * 10) / 10;
};

const calculatePercentile = (p) => calculatePercentileFromArray(metrics.latencies, p);

const metricsMiddleware = (req, res, next) => {
    const rawPath = (req.originalUrl || req.url || '/').split('?')[0];
    // Skip health check self-pings from polluting business metrics
    const isHealthPing = rawPath === '/api/health' || rawPath === '/healthz';

    if (!isHealthPing) {
        metrics.requests.total++;
        metrics.requests.active++;
    }

    const start = process.hrtime();

    // Intercept res.json to capture error message & code when status >= 400
    const origJson = res.json.bind(res);
    res.json = function (body) {
        if (res.statusCode >= 400 && body && typeof body === 'object') {
            if (body.message && !res.locals.errorMessage) {
                res.locals.errorMessage = String(body.message);
            }
            if (body.code && !res.locals.errorCode) {
                res.locals.errorCode = String(body.code);
            }
            if (Array.isArray(body.errors) && body.errors.length > 0 && !res.locals.errorDetails) {
                res.locals.errorDetails = body.errors;
                if (!res.locals.errorMessage || res.locals.errorMessage === 'Validation failed') {
                    res.locals.errorMessage = `Validation failed: ${body.errors.map(e => `${e.field || ''}: ${e.message || ''}`).join(', ')}`;
                }
            }
        }
        return origJson(body);
    };

    res.on('finish', () => {
        if (isHealthPing) return;

        metrics.requests.active = Math.max(0, metrics.requests.active - 1);
        const diff = process.hrtime(start);
        const durationMs = Math.round(((diff[0] * 1e3) + (diff[1] * 1e-6)) * 100) / 100;
        recordLatency(durationMs);

        const status = res.statusCode;
        if (status >= 200 && status < 300) metrics.requests['2xx']++;
        if (status >= 400 && status < 500) metrics.requests['4xx']++;
        if (status >= 500) metrics.requests['5xx']++;

        const trace = getTraceContext();
        const routePattern = normalizeRoute(req);
        const routeKey = `${req.method} ${routePattern}`;

        if (!metrics.routeBreakdown[routeKey]) {
            metrics.routeBreakdown[routeKey] = {
                key: routeKey,
                method: req.method,
                route: routePattern,
                total: 0,
                '2xx': 0,
                '4xx': 0,
                '5xx': 0,
                totalMs: 0,
                maxMs: 0,
                latencies: [],
                lastStatus: status,
                lastError: null,
                lastErrorAt: null,
                lastSeenAt: new Date().toISOString()
            };
        }

        const rb = metrics.routeBreakdown[routeKey];
        rb.total++;
        if (status >= 200 && status < 300) rb['2xx']++;
        if (status >= 400 && status < 500) rb['4xx']++;
        if (status >= 500) rb['5xx']++;
        rb.totalMs += durationMs;
        if (durationMs > rb.maxMs) rb.maxMs = durationMs;
        rb.latencies.push(durationMs);
        if (rb.latencies.length > 200) rb.latencies.shift();
        rb.lastStatus = status;
        rb.lastSeenAt = new Date().toISOString();

        const actorId = req.admin
            ? `ADMIN:${req.admin.email || req.admin._id}`
            : (req.user ? (req.user.phone || req.user.id) : (trace.userId || 'ANONYMOUS'));
        const actorType = req.admin
            ? 'ADMIN'
            : (req.user ? 'USER' : (trace.actorType || 'ANONYMOUS'));
        const clientIp = trace.ip || req.ip || 'UNKNOWN';

        if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
            metrics.slowRequests.unshift({
                id: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                requestId: req.id || trace.requestId,
                method: req.method,
                route: rawPath,
                routePattern,
                statusCode: status,
                durationMs,
                actorType,
                actorId,
                ip: clientIp
            });
            if (metrics.slowRequests.length > MAX_SLOW_TRACES) {
                metrics.slowRequests.pop();
            }
        }

        if (status >= 400) {
            const errMsg = res.locals.errorMessage || (status >= 500 ? 'Internal Server Error' : `HTTP ${status} Client Error`);
            const errCode = res.locals.errorCode || (status >= 500 ? 'INTERNAL_SERVER_ERROR' : `HTTP_${status}`);
            const stackSummary = res.locals.errorStack || null;

            rb.lastError = `${status}: ${errMsg}`;
            rb.lastErrorAt = new Date().toISOString();

            const failureRecord = {
                id: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                requestId: req.id || trace.requestId,
                method: req.method,
                route: rawPath,
                routePattern,
                statusCode: status,
                category: status >= 500 ? 'SERVER_5XX' : 'CLIENT_4XX',
                durationMs,
                actorType,
                actorId,
                ip: clientIp,
                userAgent: trace.userAgent || (req.headers['user-agent'] || 'Unknown').slice(0, 120),
                errorCode: errCode,
                errorMessage: errMsg,
                stackSummary
            };

            metrics.apiFailures.unshift(failureRecord);
            if (metrics.apiFailures.length > MAX_FAILURE_TRACES) {
                metrics.apiFailures.pop();
            }

            if (status >= 500) {
                const nowMs = Date.now();
                metrics.recent5xxTimestamps.push(nowMs);
                // Keep only 5xx timestamps within the last 5 minutes
                metrics.recent5xxTimestamps = metrics.recent5xxTimestamps.filter(t => nowMs - t <= 5 * 60 * 1000);

                const isSpike = metrics.recent5xxTimestamps.length >= 5;
                triggerAlert(
                    isSpike ? 'API_5XX_SPIKE' : 'API_5XX_ERROR',
                    isSpike ? 'HIGH' : 'MEDIUM',
                    {
                        route: `${req.method} ${rawPath}`,
                        path: `${req.method} ${rawPath}`,
                        method: req.method,
                        statusCode: status,
                        durationMs,
                        actorType,
                        actorId,
                        ip: clientIp,
                        requestId: req.id || trace.requestId,
                        errorCode: errCode,
                        errorMessage: errMsg,
                        stackSummary,
                        recent5xxIn5m: metrics.recent5xxTimestamps.length,
                        total5xxSinceBoot: metrics.requests['5xx']
                    }
                );
            }
        }
    });

    next();
};

const getRouteMetricsList = () => {
    return Object.values(metrics.routeBreakdown)
        .map(rb => {
            const avgMs = rb.total > 0 ? Math.round((rb.totalMs / rb.total) * 10) / 10 : 0;
            const maxMs = Math.round(rb.maxMs * 10) / 10;
            const p95Ms = calculatePercentileFromArray(rb.latencies, 95);
            return {
                key: rb.key,
                method: rb.method,
                route: `${rb.method} ${rb.route}`,
                path: rb.route,
                total: rb.total,
                '2xx': rb['2xx'],
                '4xx': rb['4xx'],
                '5xx': rb['5xx'],
                errors4xx: rb['4xx'],
                errors5xx: rb['5xx'],
                errorRatePct: rb.total > 0 ? Math.round(((rb['4xx'] + rb['5xx']) / rb.total) * 1000) / 10 : 0,
                serverErrorRatePct: rb.total > 0 ? Math.round((rb['5xx'] / rb.total) * 1000) / 10 : 0,
                avgMs,
                avgLatencyMs: avgMs,
                p95Ms,
                maxMs,
                maxLatencyMs: maxMs,
                lastStatus: rb.lastStatus,
                lastError: rb.lastError,
                lastErrorMessage: rb.lastError,
                lastErrorAt: rb.lastErrorAt,
                lastSeenAt: rb.lastSeenAt
            };
        })
        .sort((a, b) => (b['5xx'] - a['5xx']) || (b.p95Ms - a.p95Ms) || (b.total - a.total));
};

const getMetricsSnapshot = () => {
    const totalReq = metrics.requests.total || 0;
    const error5xx = metrics.requests['5xx'] || 0;
    const error4xx = metrics.requests['4xx'] || 0;
    const latency = {
        p50: calculatePercentile(50),
        p95: calculatePercentile(95),
        p99: calculatePercentile(99)
    };
    return {
        startedAt: metrics.startedAt,
        activeRequests: metrics.requests.active || 0,
        totalRequests: totalReq,
        errors5xx: error5xx,
        errors4xx: error4xx,
        uptimeSeconds: Math.round(process.uptime()),
        latency,
        http: {
            ...metrics.requests,
            errorRate5xxPct: totalReq > 0 ? Math.round((error5xx / totalReq) * 10000) / 100 : 0,
            errorRate4xxPct: totalReq > 0 ? Math.round((error4xx / totalReq) * 10000) / 100 : 0,
            slowRequestsCount: metrics.slowRequests.length,
            latency
        },
        node: {
            memory: process.memoryUsage(),
            uptime: process.uptime()
        },
        financial: metrics.financial
    };
};

const getApiFailures = (limit = 100) => metrics.apiFailures.slice(0, limit);
const getSlowRequests = (limit = 100) => metrics.slowRequests.slice(0, limit);

const getDetailedObservability = () => {
    return {
        snapshot: getMetricsSnapshot(),
        routes: getRouteMetricsList(),
        apiFailures: metrics.apiFailures,
        slowRequests: metrics.slowRequests
    };
};

const resetMetricsTelemetry = () => {
    metrics.requests['4xx'] = 0;
    metrics.requests['5xx'] = 0;
    metrics.apiFailures = [];
    metrics.slowRequests = [];
    metrics.recent5xxTimestamps = [];
    Object.values(metrics.routeBreakdown).forEach(rb => {
        rb['4xx'] = 0;
        rb['5xx'] = 0;
        rb.lastError = null;
        rb.lastErrorAt = null;
    });
};

module.exports = {
    metricsMiddleware,
    getMetricsSnapshot,
    getDetailedObservability,
    getRouteMetricsList,
    getApiFailures,
    getSlowRequests,
    resetMetricsTelemetry,
    clearTelemetryHistory: resetMetricsTelemetry,
    metrics
};
