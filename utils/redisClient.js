const {
  getRedisClient,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheInvalidatePattern,
  connectRedisStrict,
  isRedisAvailable,
  flushAllCache,
} = require('../config/redis');

module.exports = {
  getRedisClient,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheInvalidatePattern,
  connectRedisStrict,
  isRedisAvailable,
  flushAllCache,
};
