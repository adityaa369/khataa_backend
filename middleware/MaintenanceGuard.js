/**
 * Maintenance Mode Guard for V1 -> V2 Migration
 * Prevents financial mutations while allowing read-only access.
 */
class MaintenanceGuard {
    static isMigrationActive = false;
    static migrationSecret = process.env.MIGRATION_SECRET;

    static guard(req, res, next) {
        if (!MaintenanceGuard.isMigrationActive) {
            return next();
        }

        
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


        const financialPaths = [
            '/loans',       // Create Loan
            '/pay',         // Payment
            '/credit',      // Add Credit
            '/reverse',     // Reversals
            '/write-off',   // Close
            '/accrue',      // Interest Accrual
            '/accept',      // Accept Loan
            '/reject'       // Reject Loan
        ];

        const isFinancialRoute = financialPaths.some(p => req.path.includes(p));
        const isMutation = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';

        if (isMutation && isFinancialRoute) {
            return res.status(503).json({
                error: 'MIGRATION_MAINTENANCE',
                message: 'Financial operations are temporarily unavailable during the ledger upgrade.'
            });
        }

        next();
    }

    static enable() {
        this.isMigrationActive = true;
        console.log("🔒 SERVER MAINTENANCE MODE ENGAGED. Financial mutations blocked.");
    }

    static disable() {
        this.isMigrationActive = false;
        console.log("🔓 SERVER MAINTENANCE MODE LIFTED. Financial mutations allowed.");
    }
}

module.exports = MaintenanceGuard;
