/**
 * Phase 5 Dry Run Simulator (10,000-Loan Adversarial Dataset)
 */
const ProductionMigrationAnalyzer = require('../scripts/Production_Migration_Analyzer');
const crypto = require('crypto');

function generateDataset(size) {
    const loans = [];
    let idCounter = 1;
    const dt = '2026-08-01T00:00:00Z';
    const dt2 = '2026-08-02T00:00:00Z';

    // Helper generators
    const addClean = (n) => {
        for(let j=0; j<n; j++) {
            loans.push({
                _id: `L_${idCounter++}`, status: 'active',
                amountPaise: 100000, totalPayablePaise: 100000, paidAmountPaise: 0,
                transactions: []
            });
        }
    };
    
    const addPartial = (n) => {
        for(let j=0; j<n; j++) {
            loans.push({
                _id: `L_${idCounter++}`, status: 'active',
                amountPaise: 100000, totalPayablePaise: 50000, paidAmountPaise: 50000,
                transactions: [{ type: 'payment', amountPaise: 50000, recordedAt: dt }]
            });
        }
    };

    const addIdempotent = (n) => {
        for(let j=0; j<n; j++) {
            loans.push({
                _id: `L_${idCounter++}`, status: 'active', ledgerVersion: 2,
                amountPaise: 100000, totalPayablePaise: 100000, paidAmountPaise: 0,
                transactions: []
            });
        }
    };

    const addStateError = (n) => {
        for(let j=0; j<n; j++) {
            loans.push({
                _id: `L_${idCounter++}`, status: 'rejected',
                amountPaise: 100000, totalPayablePaise: 100000, paidAmountPaise: 0,
                transactions: [] // STATE_ERROR: non-zero total on rejected
            });
        }
    };

    const addAmbiguousReversal = (n) => {
        for(let j=0; j<n; j++) {
            loans.push({
                _id: `L_${idCounter++}`, status: 'active',
                amountPaise: 100000, totalPayablePaise: 100000, paidAmountPaise: 0,
                transactions: [
                    { type: 'payment', amountPaise: 5000, recordedAt: dt },
                    { type: 'payment', amountPaise: 5000, recordedAt: dt2 },
                    { type: 'payment_reversed', amountPaise: 5000, recordedAt: dt2 } // Ambiguous! No reference ID.
                ]
            });
        }
    };

    const addMissingAmount = (n) => {
        for(let j=0; j<n; j++) {
            loans.push({
                _id: `L_${idCounter++}`, status: 'active',
                totalPayablePaise: 100000, paidAmountPaise: 0,
                transactions: [] // SCHEMA_ERROR: missing amountPaise
            });
        }
    };

    const addUnknownSemantics = (n) => {
        for(let j=0; j<n; j++) {
            loans.push({
                _id: `L_${idCounter++}`, status: 'active',
                amountPaise: 100000, totalPayablePaise: 100000, paidAmountPaise: 0,
                transactions: [{ type: 'adjustment_override', amountPaise: 10000, recordedAt: dt }]
            });
        }
    };

    const addCorruption = (n) => {
        for(let j=0; j<n; j++) {
            loans.push({
                _id: `L_${idCounter++}`, status: 'active',
                amountPaise: 100000, totalPayablePaise: 70000, paidAmountPaise: 10000, // Math fails
                transactions: [{ type: 'payment', amountPaise: 10000, recordedAt: dt }]
            });
        }
    };

    const addWriteOff = (n) => {
        for(let j=0; j<n; j++) {
            loans.push({
                _id: `L_${idCounter++}`, status: 'closed',
                amountPaise: 100000, totalPayablePaise: 0, paidAmountPaise: 10000,
                transactions: [
                    { type: 'payment', amountPaise: 10000, recordedAt: dt },
                    { type: 'write_off', amountPaise: 90000, recordedAt: dt2 }
                ]
            });
        }
    };

    // GENERATE 10,000 COMBINED RECORDS
    addClean(4000);
    addPartial(3500);
    addWriteOff(500); // Legitimate edge case
    addIdempotent(1000); // Migrated safely
    
    // Hostile data (1000 total)
    addStateError(200);
    addAmbiguousReversal(200);
    addMissingAmount(200);
    addUnknownSemantics(200);
    addCorruption(200);

    return loans;
}

function run() {
    console.log("Generating 10,000-loan adversarial dataset...");
    const loans = generateDataset(10000);
    
    console.log("Executing Production Migration Analyzer (Read-Only)...");
    const report = ProductionMigrationAnalyzer.runAnalysis(loans);

    console.log("\n=========================================================================");
    console.log("             PRODUCTION-COPY MIGRATION DRY RUN REPORT                    ");
    console.log("=========================================================================\n");

    console.log("--- ZERO-MUTATION PROOF ---");
    console.log(`Before Fingerprint: ${report.fingerprints.before}`);
    console.log(`After Fingerprint : ${report.fingerprints.after}`);
    if (report.fingerprints.before === report.fingerprints.after) {
        console.log("✅ INVARIANT PASSED: Absolutely zero modifications occurred.\n");
    } else {
        console.log("❌ CRITICAL FAILURE: State mutation detected!\n");
    }

    console.log("--- PORTFOLIO AGGREGATES ---");
    console.log(`Loans Scanned: ${report.counts.total}`);
    console.log(`MIGRATABLE   : ${report.counts.migratable}`);
    console.log(`FAILED       : ${report.counts.failed}`);
    console.log(`SKIPPED      : ${report.counts.skipped}\n`);

    console.log("--- FINANCIAL CONSERVATION ---");
    console.log(`V1 Migratable Balance : ${report.money.v1Eligible}`);
    console.log(`V2 Reconstructed      : ${report.money.v2Reconstructed}`);
    if (report.money.v1Eligible === report.money.v2Reconstructed) {
         console.log("✅ Conservation Passed (Difference: 0)");
    } else {
         console.log(`❌ Difference: ${report.money.v2Reconstructed - report.money.v1Eligible}`);
    }
    console.log(`V1 Failed Balance     : ${report.money.v1Failed}\n`);

    console.log("--- TRANSACTIONS ---");
    console.log(`Total V1 Transactions : ${report.transactions.totalV1}`);
    console.log(`Mapped V2 Transactions: ${report.transactions.mappedV2}`);
    console.log(`Unmapped Transactions : ${report.transactions.unmapped}\n`);

    console.log("--- FAILURE TAXONOMY ---");
    for (const [key, val] of Object.entries(report.taxonomy)) {
        console.log(`${key.padEnd(30)}: ${val}`);
    }
    
    console.log("\n--- REPRESENTATIVE FAILURE EXAMPLES ---");
    report.representativeFailures.forEach(f => {
        console.log(`[${f.loanId}] ${f.taxonomy} (V1 State: ${f.v1State}, TxCount: ${f.transactions})`);
        console.log(`   REASON: ${f.reason}`);
    });
}

run();
