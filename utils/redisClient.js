const {
  getRedisClient,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheInvalidatePattern,
  connectRedisStrict,
  isRedisAvailable,
} = require('../config/redis');

module.exports = {
  getRedisClient,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheInvalidatePattern,
  connectRedisStrict,
  isRedisAvailable,
};
