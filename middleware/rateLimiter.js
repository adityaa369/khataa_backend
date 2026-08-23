const RateLimitService = require('../services/RateLimitService');

const createLimiter = (operation, limit, windowSeconds, failOpen = false) => {
    return async (req, res, next) => {
        const identifier = req.ip || req.connection.remoteAddress;
        const key = RateLimitService.generateKey('ip', identifier, operation);
        
        try {
            const { allowed, remaining, reset } = await RateLimitService.consume(key, limit, windowSeconds, failOpen);
            
            res.setHeader('X-RateLimit-Limit', limit);
            res.setHeader('X-RateLimit-Remaining', remaining);
            res.setHeader('X-RateLimit-Reset', reset);
            
            if (!allowed) {
                return res.status(429).json({
                    success: false,
                    message: 'Too many requests, please try again later.',
                    retryAfter: Math.ceil((reset - Date.now()) / 1000)
                });
            }
            next();
        } catch (err) {
            if (err.message === 'SERVICE_UNAVAILABLE') {
                return res.status(503).json({ success: false, message: 'Service temporarily unavailable.' });
            }
            next(err);
        }
    };
};

exports.authLimiter = createLimiter('login', 5, 300, false); // 5 attempts per 5 minutes, fail closed
exports.otpLimiter = createLimiter('otp', 3, 300, false); // 3 attempts per 5 minutes, fail closed
exports.apiLimiter = createLimiter('api', 100, 60, true); // 100 requests per minute, fail open
exports.financialLimiter = createLimiter('finance', 20, 60, false); // 20 financial mutations per minute, fail closed
exports.lookupLimiter = createLimiter('lookup', 50, 60, true); // 50 profile lookups per minute, fail open
