const RateLimitService = require('../services/RateLimitService');

const createLimiter = (operation, limit, windowSeconds, failOpen = false, keyExtractor = null) => {
    return async (req, res, next) => {
        try {
            let keys = [];
            
            if (keyExtractor) {
                const extracted = keyExtractor(req);
                if (Array.isArray(extracted)) keys = extracted.filter(Boolean);
                else if (extracted) keys = [extracted];
            } else {
                // Default layered identification
                const ipIdentifier = req.ip || req.connection?.remoteAddress || 'unknown';
                keys.push(RateLimitService.generateKey('ip', ipIdentifier, operation));
                
                if (req.user && req.user.id) {
                    keys.push(RateLimitService.generateKey('user', req.user.id, operation));
                } else if (req.body && req.body.phone) {
                    keys.push(RateLimitService.generateKey('phone', req.body.phone, operation));
                } else if (req.body && req.body.email) {
                    keys.push(RateLimitService.generateKey('email', req.body.email, operation));
                }
            }

            if (keys.length === 0) {
                return next(); // Should not happen, but fail safe
            }

            // Consume tokens across all identified dimensions (IP + User/Phone)
            const results = await Promise.all(
                keys.map(key => RateLimitService.consume(key, limit, windowSeconds, failOpen))
            );

            // Find the most restrictive result
            let minRemaining = Infinity;
            let maxReset = 0;
            let allowed = true;

            for (const result of results) {
                if (!result.allowed) allowed = false;
                if (result.remaining < minRemaining) minRemaining = result.remaining;
                if (result.reset > maxReset) maxReset = result.reset;
            }
            
            res.setHeader('X-RateLimit-Limit', limit);
            res.setHeader('X-RateLimit-Remaining', allowed ? minRemaining : 0);
            res.setHeader('X-RateLimit-Reset', maxReset);
            
            if (!allowed) {
                return res.status(429).json({
                    success: false,
                    code: 'RATE_LIMITED',
                    message: 'Too many requests, please try again later.',
                    retryAfter: Math.ceil((maxReset - Date.now()) / 1000)
                });
            }
            next();
        } catch (err) {
            if (err.message === 'SERVICE_UNAVAILABLE') {
                return res.status(503).json({ success: false, code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable.' });
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
