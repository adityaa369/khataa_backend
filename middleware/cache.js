const Redis = require('ioredis');

// Ensure Redis connection doesn't crash the app if unavailable
let redisClient;
try {
    redisClient = new Redis(process.env.REDIS_URI || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: 1,
        retryStrategy(times) {
            if (times > 3) {
                console.warn('[Redis] Connection failed, disabling cache.');
                return null;
            }
            return Math.min(times * 50, 2000);
        }
    });
    
    redisClient.on('error', (err) => {
        console.error('[Redis Cache] Error:', err.message);
    });
} catch (e) {
    console.error('[Redis Cache] Failed to initialize:', e.message);
}

/**
 * Middleware to check if response is cached
 * @param {string} keyPrefix - Prefix for the cache key (e.g., 'given_loans', 'taken_loans')
 * @param {number} ttlSeconds - Time to live in seconds
 */
const cacheMiddleware = (keyPrefix, ttlSeconds = 300) => {
    return async (req, res, next) => {
        if (!redisClient || redisClient.status !== 'ready') {
            return next();
        }

        try {
            // Generate unique cache key per user
            const userId = req.user.id;
            const cacheKey = `${keyPrefix}_${userId}`;
            
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                // If data exists, return it immediately
                return res.status(200).json(JSON.parse(cachedData));
            }
            
            // Overwrite res.json to intercept and cache the response
            const originalJson = res.json.bind(res);
            res.json = (body) => {
                if (body.success) {
                    // Cache the successful response
                    redisClient.setex(cacheKey, ttlSeconds, JSON.stringify(body)).catch(err => 
                        console.error('[Redis] Failed to cache response:', err.message)
                    );
                }
                originalJson(body);
            };
            
            next();
        } catch (error) {
            console.error('[Redis Cache Middleware] Error:', error.message);
            next(); // Proceed without cache if there's an error
        }
    };
};

/**
 * Utility to invalidate a specific user's cache
 * @param {string} userId - The ID of the user
 */
const invalidateUserCache = async (userId) => {
    if (!redisClient || redisClient.status !== 'ready') return;
    try {
        const keys = [
            `given_loans_${userId}`,
            `taken_loans_${userId}`
        ];
        await redisClient.del(...keys);
        console.log(`[Redis] Invalidated cache for user ${userId}`);
    } catch (error) {
        console.error('[Redis] Invalidation error:', error.message);
    }
};

/**
 * Utility to invalidate cache for two users (e.g. Lender and Borrower)
 */
const invalidateLoanCache = async (lenderId, borrowerId) => {
    await invalidateUserCache(lenderId);
    if (borrowerId) {
        await invalidateUserCache(borrowerId);
    }
};

module.exports = {
    redisClient,
    cacheMiddleware,
    invalidateUserCache,
    invalidateLoanCache
};
