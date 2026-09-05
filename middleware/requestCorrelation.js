const { v4: uuidv4 } = require('uuid');
const { asyncLocalStorage } = require('../utils/asyncContext');

module.exports = (req, res, next) => {
    const requestId = req.headers['x-request-id'] || uuidv4();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    
    // Create a new async context for this request
    const store = {
        requestId,
        userId: 'ANONYMOUS' // Will be populated by auth middleware
    };

    asyncLocalStorage.run(store, () => {
        const start = Date.now();
        res.on('finish', () => {
            try {
                if (req.originalUrl.startsWith('/health/')) return;

                const durationMs = Date.now() - start;
                const success = res.statusCode < 400;

                const finalStore = require('../utils/asyncContext').getTraceContext();

                const accessLog = {
                    type: 'access',
                    operation: `${req.method} ${req.route ? req.route.path : req.originalUrl.split('?')[0]}`,
                    method: req.method,
                    route: req.originalUrl,
                    statusCode: res.statusCode,
                    success,
                    durationMs
                };

                Object.assign(accessLog, finalStore);

                if (!success && res.locals.errorCode) {
                    accessLog.errorCode = res.locals.errorCode;
                }

                console.info(accessLog);
            } catch(e) {
                console.error('[Telemetry Fault]', e.message);
            }
        });

        next();
    });
};
