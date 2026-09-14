#!/usr/bin/env node
/**
 * Khataa V2 Financial Boundary Regression Gate
 *
 * Run this in CI and as a pre-commit hook to prevent re-introduction
 * of V1 financial mutation patterns.
 *
 * EXIT 0 = CLEAN (gate passes)
 * EXIT 1 = VIOLATION DETECTED (gate fails — block the merge/commit)
 *
 * Usage:
 *   node scripts/v2_financial_boundary_gate.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

// Files in these directories are in scope for the production gate.
const PRODUCTION_DIRS = ['controllers', 'workers', 'middleware', 'routes', 'services', 'utils'];

// The ONLY file permitted to write V2 Transaction documents and mutate balance fields.
const ALLOWED_MUTATION_FILES = [
    path.normalize('services/FinancialLedgerService.js'),
    path.normalize('services/InterestAccrualCalculator.js'), // pure math, no writes
];

// ─── Banned Patterns ─────────────────────────────────────────────────────────
// Each entry: { pattern, description, severity }
const BANNED_PATTERNS = [
    // V1 engine & wrapper
    { pattern: /_handleCustomTransaction/, description: 'V1 _handleCustomTransaction referenced', severity: 'P0' },
    { pattern: /custom_transactions/, description: 'V1 custom_transactions field used', severity: 'P0' },

    // V1 embedded transaction push
    { pattern: /\.transactions\.push\(\s*\{/, description: 'V1 embedded loan.transactions.push()', severity: 'P0' },
    { pattern: /type:\s*['"]loan_given['"]/, description: 'V1 loan_given transaction type', severity: 'P0' },
    { pattern: /type:\s*['"]interest_payment['"]/, description: 'V1 interest_payment type', severity: 'P0' },

    // V1 balance fields (writes)
    { pattern: /totalPayable\s*[+\-]?=\s*[^=]/, description: 'Direct write to V1 totalPayable', severity: 'P0' },
    { pattern: /totalPayablePaise\s*[+\-]?=\s*[^=]/, description: 'Direct write to V1 totalPayablePaise', severity: 'P0' },
    { pattern: /paidAmount\s*[+\-]?=\s*[^=]/, description: 'Direct write to V1 paidAmount', severity: 'P0' },
    { pattern: /paidAmountPaise\s*[+\-]?=\s*[^=]/, description: 'Direct write to V1 paidAmountPaise', severity: 'P0' },

    // Direct Transaction document mutations outside FLS
    { pattern: /Transaction\.updateOne\(/, description: 'Transaction.updateOne() outside FLS', severity: 'P0' },
    { pattern: /Transaction\.deleteOne\(/, description: 'Transaction.deleteOne() — immutable ledger violation', severity: 'P0' },
    { pattern: /Transaction\.findByIdAndUpdate\(/, description: 'Transaction.findByIdAndUpdate() — immutable ledger violation', severity: 'P0' },
    { pattern: /Transaction\.findOneAndDelete\(/, description: 'Transaction.findOneAndDelete() — immutable ledger violation', severity: 'P0' },

    // Direct balance field mutation outside FLS
    { pattern: /principalOutstandingPaise\s*=\s*[^=]/, description: 'Direct principalOutstandingPaise assignment outside FLS', severity: 'P0' },
    { pattern: /interestOutstandingPaise\s*=\s*[^=]/, description: 'Direct interestOutstandingPaise assignment outside FLS', severity: 'P0' },
    { pattern: /feesOutstandingPaise\s*=\s*[^=]/, description: 'Direct feesOutstandingPaise assignment outside FLS', severity: 'P0' },

    // Legacy toggleMonthStatus
    { pattern: /toggleMonthStatus/, description: 'toggleMonthStatus removed in V2 — re-introduced', severity: 'P1' },
    { pattern: /monthsTracking/, description: 'monthsTracking V1 field used', severity: 'P1' },
    { pattern: /recordInterest\b/, description: 'recordInterest V1 endpoint re-introduced', severity: 'P1' },
];

// ─── Scanner ──────────────────────────────────────────────────────────────────

function walkDir(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) results.push(...walkDir(full));
        else if (entry.endsWith('.js')) results.push(full);
    }
    return results;
}

function isAllowedFile(filePath) {
    return ALLOWED_MUTATION_FILES.some(allowed => path.normalize(filePath).endsWith(allowed));
}

function isCommentLine(line) {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const violations = [];

for (const dir of PRODUCTION_DIRS) {
    for (const file of walkDir(dir)) {
        if (isAllowedFile(file)) continue; // FLS is the approved mutation boundary

        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, idx) => {
            if (isCommentLine(line)) return;
            for (const rule of BANNED_PATTERNS) {
                if (rule.pattern.test(line)) {
                    violations.push({
                        file,
                        line: idx + 1,
                        code: line.trim(),
                        description: rule.description,
                        severity: rule.severity,
                    });
                }
            }
        });
    }
}

// ─── Report ───────────────────────────────────────────────────────────────────

console.log('='.repeat(72));
console.log('  Khataa V2 Financial Boundary Regression Gate');
console.log('='.repeat(72));

if (violations.length === 0) {
    console.log('\n🟢 GATE PASSED — No V1 financial mutation patterns detected in production code.\n');
    process.exit(0);
}

const p0 = violations.filter(v => v.severity === 'P0');
const p1 = violations.filter(v => v.severity === 'P1');

violations.forEach(v => {
    const icon = v.severity === 'P0' ? '🔴' : '🟠';
    console.log(`\n${icon} [${v.severity}] ${v.description}`);
    console.log(`   File : ${v.file}`);
    console.log(`   Line : ${v.line}`);
    console.log(`   Code : ${v.code.substring(0, 120)}`);
});

console.log('\n' + '='.repeat(72));
console.log(`GATE FAILED — ${violations.length} violation(s) found.`);
console.log(`  P0 (Blocker): ${p0.length}`);
console.log(`  P1 (Warning): ${p1.length}`);
console.log('Resolve all violations before merging or deploying.');
console.log('='.repeat(72) + '\n');

process.exit(1);
