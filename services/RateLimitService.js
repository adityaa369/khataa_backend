const redis = require('../utils/redisClient');
const logger = require('../utils/logger');
const { triggerAlert } = require('../utils/telemetry');

class RateLimitService {
    /**
     * Atomically consumes a token from the rate limit bucket.
     * @param {string} key - The Redis key (e.g., rl:ip:192.168.1.1:login)
     * @param {number} limit - Maximum requests allowed
     * @param {number} windowSeconds - Time window in seconds
     * @param {boolean} failOpen - If Redis crashes, should this pass (true) or block (false)?
     */
    static async consume(key, limit, windowSeconds, failOpen = false) {
        const client = redis.getRedisClient();
        if (!redis.isRedisAvailable() || !client || client.status !== 'ready') {
            if (failOpen) {
                logger.warn(`[RateLimit] Redis unavailable, failing OPEN for key: ${key}`);
                return { allowed: true, remaining: 1, reset: Date.now() + 10000 };
            } else {
                logger.error(`[RateLimit] Redis unavailable, failing CLOSED for sensitive key: ${key}`);
                throw new Error('SERVICE_UNAVAILABLE');
            }
        }

        try {
            // Atomic Lua Script: Increment counter, set TTL on first request
            const script = `
                local current = redis.call("INCR", KEYS[1])
                if current == 1 then
                    redis.call("EXPIRE", KEYS[1], ARGV[1])
                end
                local ttl = redis.call("PTTL", KEYS[1])
                return {current, ttl}
            `;
            const result = await client.eval(script, 1, key, windowSeconds);
            const currentCount = result[0];
            const ttlMs = result[1];

            const allowed = currentCount <= limit;

            if (!allowed) {
                logger.warn(`[SecurityEvent] RATE_LIMIT_EXCEEDED: Key ${key}`);
                triggerAlert('RATE_LIMIT_EXCEEDED', 'MEDIUM', { key, source: 'RATE_LIMIT_SERVICE' });
            }

            return {
                allowed,
                remaining: Math.max(0, limit - currentCount),
                reset: Date.now() + (ttlMs > 0 ? ttlMs : windowSeconds * 1000)
            };
        } catch (err) {
            logger.error(`[RateLimit] Error evaluating limit for ${key}:`, err.message);
            if (failOpen) return { allowed: true, remaining: 1, reset: Date.now() };
            throw new Error('SERVICE_UNAVAILABLE');
        }
    }

    /**
     * Helper to generate standardized keys
     */
    static generateKey(dimension, identifier, operation) {
        return `rl:${dimension}:${identifier}:${operation}`;
    }
}

module.exports = RateLimitService;

