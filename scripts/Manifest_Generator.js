const fs = require('fs');
const crypto = require('crypto');
const ProductionMigrationAnalyzer = require('./Production_Migration_Analyzer');

class ManifestGenerator {
    /**
     * Generates a durable, immutable JSON manifest for the production migration.
     * The Migration Runner MUST consume this exactly.
     */
    static generateManifest(loans, runId = null) {
        const migrationRunId = runId || `MIG_RUN_${Date.now()}`;
        console.log(`Generating Migration Manifest: ${migrationRunId}`);
        
        const analyzerReport = ProductionMigrationAnalyzer.runAnalysis(loans);
        
        const manifest = {
            migrationRunId,
            generatedAt: new Date().toISOString(),
            overallSourceFingerprint: analyzerReport.fingerprints.before,
            summary: {
                totalScanned: analyzerReport.counts.total,
                migratable: analyzerReport.counts.migratable,
                failed: analyzerReport.counts.failed,
                skipped: analyzerReport.counts.skipped
            },
            loans: {}
        };

        for (const loan of loans) {
            const analysis = ProductionMigrationAnalyzer.analyzeSingleLoan(loan);
            
            // Generate single-loan fingerprint (ID + update time + total + tx count)
            const sourceFingerprint = crypto.createHash('sha256')
                .update(loan._id + (loan.totalPayablePaise||0) + loan.status + (loan.transactions||[]).length)
                .digest('hex');

            let classification = analysis.status;
            if (loan.ledgerVersion === 2) classification = 'SKIP_ALREADY_V2';

            manifest.loans[loan._id] = {
                migrationRunId,
                loanId: loan._id,
                sourceLedgerVersion: loan.ledgerVersion || 1,
                sourceStatus: loan.status,
                sourceFingerprint,
                v1TotalPayable: loan.totalPayablePaise || 0,
                classification,
                expectedV2Principal: analysis.v2Principal || 0,
                expectedV2Interest: analysis.v2Interest || 0,
                expectedV2Fees: analysis.v2Fees || 0,
                expectedV2Total: analysis.v2Total || 0,
                expectedV2Status: analysis.mappedV2State || loan.status
            };
        }

        const manifestPath = `./migration_manifest_${migrationRunId}.json`;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(`Manifest explicitly locked and written to ${manifestPath}`);
        
        return manifest;
    }
}

module.exports = ManifestGenerator;
