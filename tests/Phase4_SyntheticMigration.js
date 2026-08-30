/**
 * Phase 4 Synthetic Migration Test Dataset
 */
const V1_V2_Migration = require('../scripts/V1_V2_Migration');

function generateSyntheticDataset() {
    const dt = new Date().toISOString();
    return [
        // 1. Clean unpaid Hand Credit
        {
            _id: '1', scenarioName: 'Clean unpaid Hand Credit', status: 'active',
            amountPaise: 100000, totalPayablePaise: 100000, paidAmountPaise: 0,
            transactions: []
        },
        // 2. Partially paid Hand Credit
        {
            _id: '2', scenarioName: 'Partially paid Hand Credit', status: 'active',
            amountPaise: 100000, totalPayablePaise: 70000, paidAmountPaise: 30000,
            transactions: [{ type: 'payment', amountPaise: 30000, recordedAt: dt }]
        },
        // 3. Fully paid Hand Credit
        {
            _id: '3', scenarioName: 'Fully paid Hand Credit', status: 'completed',
            amountPaise: 100000, totalPayablePaise: 0, paidAmountPaise: 100000,
            transactions: [{ type: 'payment', amountPaise: 100000, recordedAt: dt }]
        },
        // 4. Business Credit (Just principal for now)
        {
            _id: '4', scenarioName: 'Business Credit', status: 'active',
            amountPaise: 500000, totalPayablePaise: 500000, paidAmountPaise: 0,
            transactions: []
        },
        // 5. Interest Credit
        {
            _id: '5', scenarioName: 'Interest Credit', status: 'active',
            amountPaise: 100000, totalPayablePaise: 105000, paidAmountPaise: 0,
            transactions: [{ type: 'interest_accrued', amountPaise: 5000, recordedAt: dt }]
        },
        // 6. Interest credit with multiple historical payments
        {
            _id: '6', scenarioName: 'Interest credit multi-payments', status: 'active',
            amountPaise: 100000, totalPayablePaise: 95000, paidAmountPaise: 15000,
            transactions: [
                { type: 'interest_accrued', amountPaise: 10000, recordedAt: '2026-08-01T00:00:00Z' },
                { type: 'payment', amountPaise: 5000, recordedAt: '2026-08-05T00:00:00Z' },
                { type: 'payment', amountPaise: 10000, recordedAt: '2026-08-10T00:00:00Z' }
            ]
        },
        // 7. Loan with Add Credit
        {
            _id: '7', scenarioName: 'Loan with Add Credit', status: 'active',
            amountPaise: 100000, totalPayablePaise: 150000, paidAmountPaise: 0,
            transactions: [{ type: 'credit_added', amountPaise: 50000, recordedAt: dt }]
        },
        // 8. Loan with multiple Add Credits
        {
            _id: '8', scenarioName: 'Loan with multiple Add Credits', status: 'active',
            amountPaise: 100000, totalPayablePaise: 200000, paidAmountPaise: 0,
            transactions: [
                { type: 'credit_added', amountPaise: 50000, recordedAt: '2026-08-01' },
                { type: 'credit_added', amountPaise: 50000, recordedAt: '2026-08-02' }
            ]
        },
        // 9. Loan with reversal history
        {
            _id: '9', scenarioName: 'Loan with reversal history', status: 'active',
            amountPaise: 100000, totalPayablePaise: 100000, paidAmountPaise: 0,
            transactions: [
                { type: 'payment', amountPaise: 50000, recordedAt: '2026-08-01' },
                { type: 'payment_reversed', amountPaise: 50000, recordedAt: '2026-08-02' }
            ] 
        },
        // 10. Closed/write-off history
        {
            _id: '10', scenarioName: 'Closed/write-off history', status: 'closed',
            amountPaise: 100000, totalPayablePaise: 0, paidAmountPaise: 10000,
            transactions: [
                { type: 'payment', amountPaise: 10000, recordedAt: '2026-08-01' },
                { type: 'write_off', amountPaise: 90000, recordedAt: '2026-08-02' } // amountPaise on write_off is informational in V1
            ]
        },
        // 11. Pending loan
        {
            _id: '11', scenarioName: 'Pending loan', status: 'pending',
            amountPaise: 100000, totalPayablePaise: 0, paidAmountPaise: 0,
            transactions: []
        },
        // 12. Rejected loan
        {
            _id: '12', scenarioName: 'Rejected loan', status: 'rejected',
            amountPaise: 100000, totalPayablePaise: 0, paidAmountPaise: 0,
            transactions: []
        },
        // 13. Cancelled loan
        {
            _id: '13', scenarioName: 'Cancelled loan', status: 'cancelled',
            amountPaise: 100000, totalPayablePaise: 0, paidAmountPaise: 0,
            transactions: []
        },
        // 14. Expired loan
        {
            _id: '14', scenarioName: 'Expired loan', status: 'expired',
            amountPaise: 100000, totalPayablePaise: 0, paidAmountPaise: 0,
            transactions: []
        },
        // 15. Ambiguous historical payment allocation (Overpayment in history)
        {
            _id: '15', scenarioName: 'Ambiguous historical payment allocation', status: 'active',
            amountPaise: 100000, totalPayablePaise: -20000, paidAmountPaise: 120000,
            transactions: [{ type: 'payment', amountPaise: 120000, recordedAt: dt }]
        },
        // 16. Corrupted V1 balance (Math doesn't add up)
        {
            _id: '16', scenarioName: 'Corrupted V1 balance', status: 'active',
            amountPaise: 100000, totalPayablePaise: 90000, paidAmountPaise: 5000, // 100k - 5k = 95k != 90k
            transactions: [{ type: 'payment', amountPaise: 5000, recordedAt: dt }]
        },
        // 17. Missing transaction data
        {
            _id: '17', scenarioName: 'Missing transaction data', status: 'active',
            amountPaise: 100000, totalPayablePaise: 50000, paidAmountPaise: 50000,
            transactions: [] 
        },
        // 18. Unexpected/unknown V1 transaction type
        {
            _id: '18', scenarioName: 'Unexpected/unknown V1 transaction type', status: 'active',
            amountPaise: 100000, totalPayablePaise: 100000, paidAmountPaise: 0,
            transactions: [{ type: 'mystery_tx_garbage', amountPaise: 50000, recordedAt: dt }]
        },
        // EXTRA: Idempotency Test (Skipping already migrated)
        {
            _id: '19', scenarioName: 'Idempotency Skip', status: 'active',
            ledgerVersion: 2, amountPaise: 100000, totalPayablePaise: 100000, paidAmountPaise: 0,
            transactions: []
        }
    ];
}

async function run() {
    const data = generateSyntheticDataset();
    const report = await V1_V2_Migration.runMigration(data, true); 

    console.log("=========================================================================");
    console.log("             V1 -> V2 MIGRATION DRY RUN RECONCILIATION REPORT            ");
    console.log("=========================================================================");
    console.log(`Total Processed: ${report.totalProcessed}`);
    console.log(`Successfully Reconciled: ${report.success}`);
    console.log(`Failed & Frozen: ${report.failed}`);
    console.log(`Skipped (Idempotent): ${report.skipped}`);
    
    console.log(`\n--- AGGREGATE ARITHMETIC VALIDATION ---`);
    console.log(`V1 Authoritative Total: ${report.v1TotalPaise} paise`);
    console.log(`V2 Reconstructed Total (Successful only): ${report.v2ReconstructedPaise} paise`);
    
    // Validate the report arithmetic internally
    let sumV1 = 0;
    report.details.forEach(d => sumV1 += d.v1Total);
    if (sumV1 !== report.v1TotalPaise) {
        console.error(`\n[CRITICAL ERROR] Report Arithmetic mismatch: Sum of Details (${sumV1}) != Report Total (${report.v1TotalPaise})`);
        return;
    }
    console.log(`✅ Aggregate Arithmetic Reconciled.\n`);

    console.log("DETAILS:\n");
    report.details.forEach(d => {
        if (d.status === 'MIGRATION_SUCCESS') {
            console.log(`✅ [${d.loanId}] ${d.scenario}`);
            console.log(`   V1 Total: ${d.v1Total} | V2 Total: ${d.v2Total} | V2 Ledger Sum: ${d.v2LedgerSum}`);
            console.log(`   (P:${d.v2Principal}, I:${d.v2Interest}, F:${d.v2Fees}) | ${d.reason}`);
        } else {
            console.log(`❌ [${d.loanId}] ${d.scenario}`);
            console.log(`   STATUS: ${d.status}`);
            console.log(`   REASON: ${d.reason}`);
            console.log(`   V1 Total: ${d.v1Total} | V2 Recon Result: ${d.v2Total}`);
            console.log(`   Reconciliation Diff (V2 - V1): ${d.reconciliationDiff}`);
        }
        console.log("-------------------------------------------------------------------------");
    });
}

run();
