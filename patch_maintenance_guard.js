const fs = require('fs');
let mg = fs.readFileSync('middleware/MaintenanceGuard.js', 'utf8');

const secureBypass = `
        // Secure bypass for the internal migration worker only
        // MUST originate from localhost/internal loopback AND have the secret
        const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::ffff:127.0.0.1' || req.ip === '::1';
        if (req.headers['x-migration-bypass'] === MaintenanceGuard.migrationSecret) {
            if (!isLocalhost) {
                console.warn('[SECURITY] External attempt to use migration bypass from IP:', req.ip);
                return res.status(403).json({ error: 'FORBIDDEN_BYPASS', message: 'Migration bypass restricted to internal network' });
            }
            return next();
        }
`;

mg = mg.replace(
    /\/\/ Secure bypass for the internal migration worker only[\s\S]*?return next\(\);\n        \}/m,
    secureBypass
);

fs.writeFileSync('middleware/MaintenanceGuard.js', mg);
console.log('MaintenanceGuard migration bypass secured.');
