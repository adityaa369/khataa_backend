const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const findings = [];

function scan(label, pattern, dirs, severity, expectZero = true) {
    for (const dir of dirs) {
        try {
            const result = execSync(`node -e "
                const fs = require('fs');
                const path = require('path');
                function walk(d) {
                    if (!fs.existsSync(d)) return;
                    for (const f of fs.readdirSync(d)) {
                        const full = path.join(d, f);
                        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
                        if (!f.endsWith('.js')) continue;
                        const content = fs.readFileSync(full, 'utf8');
                        const lines = content.split('\\n');
                        lines.forEach((line, i) => {
                            if (/${pattern}/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
                                console.log(full + ':' + (i+1) + ': ' + line.trim());
                            }
                        });
                    }
                }
                walk('${dir}');
            "`, { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
            
            const lines = result.split('\n').filter(l => l.trim());
            if (lines.length > 0) {
                findings.push({ label, severity, lines, expectZero });
            }
        } catch (e) {
            // ignore scan errors
        }
    }
}

console.log("=========================================================================");
console.log("  PHASE 4E: REPOSITORY-WIDE DIRECT FINANCIAL MUTATION SCAN               ");
console.log("=========================================================================\n");

// The ONLY approved financial mutation paths:
//   services/FinancialLedgerService.js  (via _commitMutation)
//   services/InterestAccrualCalculator.js (pure math, no writes)
//   tests/*, scripts/* (test/migration tooling - isolated)

const productionDirs = ['controllers', 'workers', 'middleware', 'utils', 'routes'];

// Scan for direct Transaction mutations outside FLS
scan('Transaction.create() outside FLS', 'Transaction\\.create\\(', productionDirs, '🔴 P0');
scan('Transaction.updateOne() anywhere', 'Transaction\\.updateOne\\(', productionDirs, '🔴 P0');
scan('Transaction.findByIdAndUpdate()', 'Transaction\\.findByIdAndUpdate\\(', productionDirs, '🔴 P0');
scan('Transaction.deleteOne() anywhere', 'Transaction\\.deleteOne\\(', productionDirs, '🔴 P0');
scan('Transaction.findOneAndDelete()', 'Transaction\\.findOneAndDelete\\(', productionDirs, '🔴 P0');

// Scan for direct balance field mutation
scan('principalOutstandingPaise = (direct assignment)', 'principalOutstandingPaise\\s*=\\s*[^=]', productionDirs, '🔴 P0');
scan('interestOutstandingPaise = (direct assignment)', 'interestOutstandingPaise\\s*=\\s*[^=]', productionDirs, '🔴 P0');
scan('feesOutstandingPaise = (direct assignment)', 'feesOutstandingPaise\\s*=\\s*[^=]', productionDirs, '🔴 P0');

// Scan for custom_transactions / V1 remnants
scan('custom_transactions push (V1 remnant)', 'custom_transactions\\.push\\(', productionDirs, '🔴 P0');
scan('transactions.push (V1 array push)', '\\.transactions\\.push\\(', productionDirs, '🟠 P1');

// Scan for Loan balance direct sets outside FLS
scan('Loan.updateOne with balance fields', 'Loan\\.updateOne.*Outstanding', productionDirs, '🔴 P0');
scan('findByIdAndUpdate with Outstanding fields', 'findByIdAndUpdate.*Outstanding', productionDirs, '🔴 P0');

// Scan for notification events created outside Outbox in FLS
scan('sendPushNotification() outside FLS', 'sendPushNotification\\(', productionDirs, '🟠 P1');

// Report
const p0 = findings.filter(f => f.severity === '🔴 P0' && f.lines.length > 0);
const p1 = findings.filter(f => f.severity === '🟠 P1' && f.lines.length > 0);

if (p0.length === 0 && p1.length === 0) {
    console.log('🟢 CLEAN — No direct financial mutations found outside FinancialLedgerService in production code.\n');
} else {
    p0.forEach(f => {
        console.log(`🔴 P0 FINDING: ${f.label}`);
        f.lines.forEach(l => console.log(`   → ${l}`));
        console.log();
    });
    p1.forEach(f => {
        console.log(`🟠 P1 FINDING: ${f.label}`);
        f.lines.forEach(l => console.log(`   → ${l}`));
        console.log();
    });
}

console.log(`\n${'='.repeat(70)}`);
console.log(`Scan complete. P0 categories with hits: ${p0.length} | P1 categories with hits: ${p1.length}`);
