const https = require('https');
const http = require('http');
const mongoose = require('mongoose');

const DEFAULT_PUBLIC_URL = (
    process.env.RENDER_EXTERNAL_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    'https://khataa-backend.onrender.com'
).replace(/\/$/, '');

const PING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (prevents Render 15-min free-tier spin-down)

const state = {
    enabled: true,
    intervalMinutes: 5,
    targetUrl: `${DEFAULT_PUBLIC_URL}/api/health`,
    startedAt: new Date().toISOString(),
    lastPingAt: null,
    nextPingAt: new Date(Date.now() + PING_INTERVAL_MS).toISOString(),
    lastStatus: 'INITIALIZING',
    lastHttpCode: null,
    lastLatencyMs: null,
    lastError: null,
    totalPings: 0,
    successfulPings: 0,
    consecutiveFailures: 0,
    history: [] // Last 30 keep-alive checks
};

let timerHandle = null;

function pushHistory(entry) {
    state.history.unshift(entry);
    if (state.history.length > 30) {
        state.history.length = 30;
    }
}

function performHttpGet(urlStr, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const start = process.hrtime.bigint();
        const client = urlStr.startsWith('https') ? https : http;
        const req = client.get(
            urlStr,
            {
                headers: {
                    'User-Agent': 'HandCredit-KeepAliveWorker/1.0',
                    'Accept': 'application/json',
                    'X-Keep-Alive-Probe': 'true'
                },
                timeout: timeoutMs
            },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => {
                    if (raw.length < 2048) raw += chunk;
                });
                res.on('end', () => {
                    const latencyMs = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100;
                    resolve({
                        statusCode: res.statusCode,
                        latencyMs,
                        body: raw
                    });
                });
            }
        );

        req.on('timeout', () => {
            req.destroy(new Error('Keep-alive probe timed out'));
        });

        req.on('error', (err) => {
            const latencyMs = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100;
            err.latencyMs = latencyMs;
            reject(err);
        });
    });
}

async function pingNow(source = 'scheduled-5m') {
    const now = new Date();
    state.lastPingAt = now.toISOString();
    state.nextPingAt = new Date(now.getTime() + PING_INTERVAL_MS).toISOString();
    state.totalPings += 1;

    try {
        // 1. Warm MongoDB connection pool
        if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
            await mongoose.connection.db.admin().ping();
        }

        // 2. Hit external Render URL so Render's edge load balancer counts inbound traffic
        const target = `${state.targetUrl}?source=${encodeURIComponent(source)}&t=${now.getTime()}`;
        const result = await performHttpGet(target);

        state.lastHttpCode = result.statusCode;
        state.lastLatencyMs = result.latencyMs;

        if (result.statusCode >= 200 && result.statusCode < 400) {
            state.lastStatus = 'HEALTHY';
            state.lastError = null;
            state.successfulPings += 1;
            state.consecutiveFailures = 0;
        } else {
            state.lastStatus = 'DEGRADED';
            state.lastError = `HTTP ${result.statusCode}`;
            state.consecutiveFailures += 1;
        }

        pushHistory({
            timestamp: state.lastPingAt,
            source,
            status: state.lastStatus,
            httpCode: result.statusCode,
            latencyMs: result.latencyMs
        });

        return {
            ok: state.lastStatus === 'HEALTHY',
            ...getKeepAliveStatus()
        };
    } catch (err) {
        state.lastStatus = 'DEGRADED';
        state.lastHttpCode = 0;
        state.lastLatencyMs = err.latencyMs || null;
        state.lastError = err.message;
        state.consecutiveFailures += 1;

        pushHistory({
            timestamp: state.lastPingAt,
            source,
            status: 'FAILED',
            httpCode: 0,
            latencyMs: err.latencyMs || null,
            error: err.message
        });

        return {
            ok: false,
            error: err.message,
            ...getKeepAliveStatus()
        };
    }
}

function startKeepAlive(intervalMs = PING_INTERVAL_MS) {
    if (timerHandle) clearInterval(timerHandle);
    state.intervalMinutes = Math.max(1, Math.round(intervalMs / 60000));

    // Initial warm-up ping 15 seconds after server boot
    setTimeout(() => {
        pingNow('startup-warmup').catch(() => {});
    }, 15 * 1000);

    timerHandle = setInterval(() => {
        pingNow('scheduled-5m').catch(() => {});
    }, intervalMs);

    if (typeof timerHandle.unref === 'function') {
        timerHandle.unref();
    }

    console.log(`[KeepAliveWorker] Active — Pinging ${state.targetUrl} every ${state.intervalMinutes} minutes to prevent Render free-tier spin-down.`);
}

function getKeepAliveStatus() {
    return {
        ...state,
        uptimeSeconds: Math.round(process.uptime())
    };
}

module.exports = {
    startKeepAlive,
    pingNow,
    getKeepAliveStatus
};
