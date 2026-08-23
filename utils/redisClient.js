const Redis = require('ioredis');

// Default to localhost if no ENV provided
const redis = new Redis(process.env.REDIS_URI || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
        if (times > 3) {
            console.error('[Redis] Max retries reached, failing over...');
            return null; // Stop retrying
        }
        return Math.min(times * 50, 2000);
    }
});

redis.on('error', (err) => {
    console.error('[Redis] Connection Error:', err.message);
});

redis.on('connect', () => {
    console.log('[Redis] Connected successfully.');
});

module.exports = redis;
