// middleware/metrics.js
const { triggerAlert } = require('../utils/telemetry');

const metrics = {
    requests: {
        total: 0,
        active: 0,
        '2xx': 0,
        '4xx': 0,
        '5xx': 0
    },
    latencies: [],
    financial: {
        paymentsAttempted: 0,
        paymentsCommitted: 0,
        paymentsRejected: 0,
        idempotencyReplays: 0,
        transactionAborts: 0
    }
};

const recordLatency = (durationMs) => {
    metrics.latencies.push(durationMs);
    if (metrics.latencies.length > 1000) metrics.latencies.shift(); // Keep recent 1k
};

const calculatePercentile = (p) => {
    if (metrics.latencies.length === 0) return 0;
    const sorted = [...metrics.latencies].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * (p / 100);
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
        return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    } else {
        return sorted[base];
    }
};

const metricsMiddleware = (req, res, next) => {
    metrics.requests.total++;
    metrics.requests.active++;
    
    const start = process.hrtime();
    
    res.on('finish', () => {
        metrics.requests.active--;
        const diff = process.hrtime(start);
        const durationMs = (diff[0] * 1e3) + (diff[1] * 1e-6);
        recordLatency(durationMs);
        
        if (res.statusCode >= 200 && res.statusCode < 300) metrics.requests['2xx']++;
        if (res.statusCode >= 400 && res.statusCode < 500) metrics.requests['4xx']++;
        if (res.statusCode >= 500) {
            metrics.requests['5xx']++;
            // Alert if 5xx spike (arbitrary simple check)
            if (metrics.requests['5xx'] > 10) {
                triggerAlert('API_5XX_SPIKE', 'HIGH', { count: metrics.requests['5xx'] });
            }
        }
    });
    
    next();
};

const getMetricsSnapshot = () => {
    return {
        http: {
            ...metrics.requests,
            latency: {
                p50: calculatePercentile(50),
                p95: calculatePercentile(95),
                p99: calculatePercentile(99)
            }
        },
        node: {
            memory: process.memoryUsage(),
            uptime: process.uptime()
        },
        financial: metrics.financial
    };
};

module.exports = { metricsMiddleware, getMetricsSnapshot, metrics };
