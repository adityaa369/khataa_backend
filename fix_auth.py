import sys

filepath = 'controllers/auth.js'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace the direct redis calls in setupMpin
content = content.replace("""const redisClient = getRedisClient();
        if (redisClient) {
            await redisClient.del(mpin_attempts:);
        }""", """const { cacheInvalidate } = require('../config/redis');
        await cacheInvalidate(mpin_attempts:);""")

# Replace the direct redis calls in changeMpin
content = content.replace("""const { getRedisClient } = require('../config/redis');
        const redisClient = getRedisClient();
        if (redisClient) {
            await redisClient.del('mpin_attempts:' + req.user.id);
        }""", """const { cacheInvalidate } = require('../config/redis');
        await cacheInvalidate('mpin_attempts:' + req.user.id);""")

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
print('Fixed auth.js.')
