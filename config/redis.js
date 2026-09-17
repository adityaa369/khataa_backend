const Redis = require('ioredis');

let redisClient = null;
let redisAvailable = false;

function getRedisClient() {
    if (redisClient) return redisClient;

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        console.log('[REDIS] REDIS_URL not set — caching disabled, app will work without Redis.');
        return null;
    }

    redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: false,
        reconnectOnError: (err) => {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) return true;
            return false;
        },
        retryStrategy: (times) => {
            if (times > 5) {
                console.log('[REDIS] Max retries reached — disabling Redis cache.');
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

// In-memory fallback
const memCache = new Map();

async function cacheGet(key) {
    try {
        const client = getRedisClient();
        if (!client || !redisAvailable) {
            const val = memCache.get(key);
            if (val && val.expires > Date.now()) return val.data;
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
        const client = getRedisClient();
        if (!client || !redisAvailable) {
            memCache.set(key, { data: value, expires: Date.now() + (ttlSeconds * 1000) });
            return;
        }
        await client.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
        // silent
    }
}

async function cacheInvalidate(...keys) {
    try {
        const client = getRedisClient();
        if (!client || !redisAvailable) {
            keys.forEach(k => memCache.delete(k));
            return;
        }
        if (keys.length > 0) await client.del(...keys);
    } catch {
        // silent
    }
}

async function cacheInvalidatePattern(pattern) {
    try {
        const client = getRedisClient();
        if (!client || !redisAvailable) {
            // Very naive pattern match for memory fallback
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
            for (const k of memCache.keys()) {
                if (regex.test(k)) memCache.delete(k);
            }
            return;
        }
        const keys = await client.keys(pattern);
        if (keys.length > 0) await client.del(...keys);
    } catch {
        // silent
    }
}

module.exports = { getRedisClient, cacheGet, cacheSet, cacheInvalidate, cacheInvalidatePattern };
