const Redis = require('ioredis');

let redisClient = null;
let redisAvailable = false;

function getRedisClient() {
  if (redisClient) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error(
      '[REDIS] REDIS_URL is required. Refusing to initialize Redis without an explicit production configuration.'
    );
  }

  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,

    reconnectOnError: (err) => {
      if (err && err.message && err.message.includes('READONLY')) {
        return true;
      }
      return false;
    },

    retryStrategy: (times) => {
      if (times > 5) {
        console.error('[REDIS] Max retries reached.');
        redisAvailable = false;
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  });

  redisClient.on('connect', () => {
    console.log('[REDIS] TCP connection established.');
  });

  redisClient.on('ready', () => {
    redisAvailable = true;
    console.log('[REDIS] Ready.');
  });

  redisClient.on('error', (err) => {
    redisAvailable = false;
    console.error('[REDIS] Connection error:', err.message);
  });

  redisClient.on('close', () => {
    redisAvailable = false;
    console.warn('[REDIS] Connection closed.');
  });

  return redisClient;
}

async function connectRedisStrict() {
  const client = getRedisClient();

  try {
    if (client.status !== 'ready') {
      await client.connect();
    }

    const response = await client.ping();

    if (response !== 'PONG') {
      throw new Error(Unexpected Redis PING response: );
    }

    redisAvailable = true;

    console.log('[REDIS] PING → PONG');
    console.log('[REDIS] Production Redis health check PASSED');

    return true;
  } catch (error) {
    redisAvailable = false;

    console.error(
      '[REDIS] CRITICAL: Production Redis health check FAILED:',
      error.message
    );

    throw error;
  }
}

function isRedisAvailable() {
  return redisAvailable;
}

async function cacheGet(key) {
  const client = getRedisClient();
  if (!client || !redisAvailable) {
    return null;
  }

  try {
    const val = await client.get(key);
    return val ? JSON.parse(val) : null;
  } catch (error) {
    console.error('[REDIS CACHE] GET failed:', error.message);
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds = 120) {
  const client = getRedisClient();
  if (!client || !redisAvailable) {
    return false;
  }

  try {
    await client.set(
      key,
      JSON.stringify(value),
      'EX',
      ttlSeconds
    );
    return true;
  } catch (error) {
    console.error('[REDIS CACHE] SET failed:', error.message);
    return false;
  }
}

async function cacheInvalidate(...keys) {
  const client = getRedisClient();
  if (!client || !redisAvailable) return;
  try {
    if (keys.length > 0) await client.del(...keys);
  } catch (error) {
    // silent
  }
}

async function cacheInvalidatePattern(pattern) {
  const client = getRedisClient();
  if (!client || !redisAvailable) return;
  try {
    const keys = await client.keys(pattern);
    if (keys.length > 0) await client.del(...keys);
  } catch (error) {
    // silent
  }
}

module.exports = {
  getRedisClient,
  connectRedisStrict,
  isRedisAvailable,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheInvalidatePattern
};
