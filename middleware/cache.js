const { getRedisClient, isRedisAvailable } = require('../config/redis');

/**
 * Middleware to check if response is cached
 * @param {string} keyPrefix - Prefix for the cache key (e.g., 'given_loans', 'taken_loans')
 * @param {number} ttlSeconds - Time to live in seconds
 */
const cacheMiddleware = (keyPrefix, ttlSeconds = 300) => {
    return async (req, res, next) => {
        const client = getRedisClient();
        if (!client || !isRedisAvailable()) {
            return next();
        }

        try {
            // Generate unique cache key per user
            const userId = req.user.id;
            const cacheKey = \\_\\;
            
            const cachedData = await client.get(cacheKey);
            if (cachedData) {
                // If data exists, return it immediately
                return res.status(200).json(JSON.parse(cachedData));
            }
            
            // Overwrite res.json to intercept and cache the response
            const originalJson = res.json.bind(res);
            res.json = (body) => {
                if (body.success) {
                    // Cache the successful response
                    client.setex(cacheKey, ttlSeconds, JSON.stringify(body)).catch(err => 
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
    const client = getRedisClient();
    if (!client || !isRedisAvailable()) return;
    try {
        const keys = [
            \given_loans_\\,
            \	aken_loans_\\
        ];
        await client.del(...keys);
        console.log(\[Redis] Invalidated cache for user \\);
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
    cacheMiddleware,
    invalidateUserCache,
    invalidateLoanCache
};
