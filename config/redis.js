const Redis = require('ioredis');

let redisClient = null;
let redisAvailable = false;

function getRedisClient() {
    if (redisClient) return redisClient;

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        return null;
    }

    redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: false,
        reconnectOnError: (err) => {
            const targetError = 'READONLY';
            if (err && err.message && err.message.includes(targetError)) return true;
            return false;
        },
        retryStrategy: (times) => {
            if (times > 5) {
                console.log('[REDIS] Max retries reached — using in-memory cache fallback.');
                redisAvailable = false;
                return null; // stop retrying
            }
            return Math.min(times * 200, 2000);
        },
        lazyConnect: true,
    });

    redisClient.on('connect', () => {
        redisAvailable = true;
        console.log('[REDIS] Connected successfully.');
    });

    redisClient.on('ready', () => {
        redisAvailable = true;
    });

    redisClient.on('error', (err) => {
        redisAvailable = false;
        if (process.env.NODE_ENV !== 'production') {
            console.error('[REDIS] Error:', err.message);
        }
    });

    redisClient.on('close', () => {
        redisAvailable = false;
    });

    redisClient.connect().catch(() => {
        redisAvailable = false;
    });

    return redisClient;
}

function isRedisAvailable() {
    return Boolean(redisAvailable && redisClient && redisClient.status === 'ready');
}

async function connectRedisStrict() {
    const client = getRedisClient();
    if (!client) {
        return false;
    }
    try {
        if (client.status !== 'ready') {
            await client.connect();
        }
        const pong = await client.ping();
        redisAvailable = pong === 'PONG';
        return redisAvailable;
    } catch {
        redisAvailable = false;
        return false;
    }
}

// In-memory fallback
const memCache = new Map();

async function cacheGet(key) {
    try {
        const client = getRedisClient();
        if (!client || !redisAvailable) {
            const val = memCache.get(key);
            if (val && val.expires > Date.now()) return val.data;
            if (val) memCache.delete(key);
            return null;
        }
        const val = await client.get(key);
        return val ? JSON.parse(val) : null;
    } catch {
        return null;
    }
}

async function cacheSet(key, value, ttlSeconds = 120) {
    try {
        memCache.set(key, { data: value, expires: Date.now() + (ttlSeconds * 1000) });
        const client = getRedisClient();
        if (!client || !redisAvailable) {
            return true;
        }
        await client.setex(key, ttlSeconds, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

async function cacheInvalidate(...keys) {
    try {
        keys.forEach(k => memCache.delete(k));
        const client = getRedisClient();
        if (!client || !redisAvailable) {
            return;
        }
        if (keys.length > 0) await client.del(...keys);
    } catch {
        // silent
    }
}

async function cacheInvalidatePattern(pattern) {
    try {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        for (const k of memCache.keys()) {
            if (regex.test(k)) memCache.delete(k);
        }
        const client = getRedisClient();
        if (!client || !redisAvailable) {
            return;
        }
        const keys = await client.keys(pattern);
        if (keys.length > 0) await client.del(...keys);
    } catch {
        // silent
    }
}

async function flushAllCache() {
    try {
        memCache.clear();
        const client = getRedisClient();
        if (client && redisAvailable) {
            await client.flushdb();
        }
    } catch {
        // silent
    }
}

module.exports = {
    getRedisClient,
    isRedisAvailable,
    connectRedisStrict,
    cacheGet,
    cacheSet,
    cacheInvalidate,
    cacheInvalidatePattern,
    flushAllCache,
};
