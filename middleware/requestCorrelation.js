const crypto = require('crypto');
const { asyncLocalStorage } = require('../utils/asyncContext');

module.exports = (req, res, next) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);

    const cleanPath = (req.originalUrl || req.url || '').split('?')[0];
    const clientIp = (req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : null) || req.ip || req.socket?.remoteAddress || 'UNKNOWN';

    const store = {
        requestId,
        userId: 'ANONYMOUS',
        actorType: 'ANONYMOUS',
        ip: clientIp,
        method: req.method,
        path: cleanPath,
        userAgent: (req.headers['user-agent'] || 'Unknown').slice(0, 120)
    };

    asyncLocalStorage.run(store, () => {
        const start = Date.now();
        res.on('finish', () => {
            try {
                if (cleanPath.startsWith('/health') || cleanPath === '/api/health' || cleanPath === '/api/test') return;

                const durationMs = Date.now() - start;
                const success = res.statusCode < 400;

                const finalStore = require('../utils/asyncContext').getTraceContext();

                const accessLog = {
                    type: 'access',
                    operation: `${req.method} ${req.route ? req.route.path : cleanPath}`,
                    method: req.method,
                    route: cleanPath,
                    statusCode: res.statusCode,
                    success,
                    durationMs
                };

                Object.assign(accessLog, finalStore);

                if (!success && res.locals.errorCode) {
                    accessLog.errorCode = res.locals.errorCode;
                }
                if (!success && res.locals.errorMessage) {
                    accessLog.errorMessage = res.locals.errorMessage;
                }

                console.info(accessLog);
            } catch (e) {
                console.error('[Telemetry Fault]', e.message);
            }
        });

        next();
    });
};
