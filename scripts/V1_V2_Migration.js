const mongoose = require('mongoose');

class V1_V2_Migration {
    /**
     * Executes the V1 to V2 Ledger Migration in Dry Run or Commit mode.
     */
    static async runMigration(loans, dryRun = true) {
        const report = {
            totalProcessed: 0,
            success: 0,
            failed: 0,
            skipped: 0,
            v1TotalPaise: 0,
            v2ReconstructedPaise: 0,
            details: []
        };

        for (const v1Loan of loans) {
            report.totalProcessed++;

            // Idempotency: Skip already migrated
            if (v1Loan.ledgerVersion === 2) {
                report.skipped++;
                continue;
            }

            const v1Expected = v1Loan.totalPayablePaise || 0;
            report.v1TotalPaise += v1Expected;

            const result = this.processSingleLoan(v1Loan);
            
            report.details.push({
                loanId: v1Loan._id,
                scenario: v1Loan.scenarioName || 'Unknown',
                status: result.status,
                v1Total: v1Expected,
                v2Principal: result.v2Principal,
                v2Interest: result.v2Interest,
                v2Fees: result.v2Fees,
                v2Total: result.v2Total,
                v2LedgerSum: result.v2LedgerSum,
                reconciliationDiff: result.v2Total - v1Expected,
                reason: result.reason
            });

            if (result.status === 'MIGRATION_SUCCESS') {
                report.success++;
                report.v2ReconstructedPaise += result.v2Total;
            } else {
                report.failed++;
            }
        }
        return report;
    }

    static processSingleLoan(v1Loan) {
        // Business Rule: Pre-active loans do not have outstanding financial debt
        const preActiveStates = ['pending', 'pending_approval', 'rejected', 'cancelled', 'expired'];
        const isPreActive = preActiveStates.includes(v1Loan.status);
        
        // 1. Initial V1 State Mapping
        let p = 0;
        let i = 0;
        let f = 0;
        
        // If it's active/completed/closed, the requested amount became principal
        if (!isPreActive) {
            if (v1Loan.amountPaise === undefined) return this._fail('CORRUPTED: Missing amountPaise');
            p = v1Loan.amountPaise;
        } else {
            // Pending loans should not have transactions or expected debt
            if (v1Loan.totalPayablePaise > 0) return this._fail('CORRUPTED: Pre-active loan has expected debt');
            if (v1Loan.transactions && v1Loan.transactions.length > 0) return this._fail('CORRUPTED: Pre-active loan has transactions');
        }

        // 2. Chronological Transaction Replay
        const txs = v1Loan.transactions || [];
        txs.sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));

        let paidAmountPaiseAcc = 0;

        for (const tx of txs) {
            if (tx.amountPaise === undefined) return this._fail('CORRUPTED: Transaction missing amountPaise');

            switch (tx.type) {
                case 'loan_given':
                case 'credit_added':
                    p += tx.amountPaise;
                    break;
                case 'interest_accrued': 
                    i += tx.amountPaise;
                    break;
                case 'fee_assessed':
                    f += tx.amountPaise;
                    break;
                case 'payment':
                    paidAmountPaiseAcc += tx.amountPaise;
                    let remaining = tx.amountPaise;
                    
                    const feeAlloc = Math.min(remaining, f);
                    f -= feeAlloc;
                    remaining -= feeAlloc;
                    
                    const intAlloc = Math.min(remaining, i);
                    i -= intAlloc;
                    remaining -= intAlloc;
                    
                    const pAlloc = Math.min(remaining, p);
                    p -= pAlloc;
                    remaining -= pAlloc;
                    
                    if (remaining > 0) return this._fail(`AMBIGUOUS: Overpayment detected in history. Remaining: ${remaining}`);
                    break;
                case 'payment_reversed':
                    // Reverses a payment. In V1 absence of components, we reverse back to principal
                    p += tx.amountPaise;
                    paidAmountPaiseAcc -= tx.amountPaise;
                    break;
                case 'write_off':
                    // Forgiveness drives balances to 0
                    p = 0;
                    i = 0;
                    f = 0;
                    break;
                default:
                    return this._fail(`UNKNOWN_TRANSACTION_TYPE: ${tx.type}`);
            }

            if (p < 0 || i < 0 || f < 0) return this._fail('CORRUPTED: Negative balance reached during replay');
        }

        // 3. Check for silent unrecorded payments
        if (v1Loan.paidAmountPaise !== undefined && v1Loan.paidAmountPaise !== paidAmountPaiseAcc) {
            return this._fail(`MISSING_DATA: paidAmountPaise (${v1Loan.paidAmountPaise}) != tx sum (${paidAmountPaiseAcc})`);
        }

        // 4. Final V1 vs V2 Reconciliation Check
        const v2Total = p + i + f;
        const v1Expected = v1Loan.totalPayablePaise || 0;
        
        // Ledger sum matches materialized because we just generated it deterministically
        const v2LedgerSum = v2Total;

        if (v2Total !== v1Expected) {
            return this._fail(`RECONCILIATION_MISMATCH: V1=${v1Expected} vs V2=${v2Total}`, v2Total);
        }

        // 5. State Match Validation
        let mappedV2State = 'ACTIVE';
        if (isPreActive) mappedV2State = v1Loan.status.toUpperCase();
        else if (v2Total === 0 && txs.some(t => t.type === 'write_off')) mappedV2State = 'CLOSED';
        else if (v2Total === 0) mappedV2State = 'COMPLETED';

        return {
            status: 'MIGRATION_SUCCESS',
            v2Principal: p,
            v2Interest: i,
            v2Fees: f,
            v2Total: v2Total,
            v2LedgerSum: v2LedgerSum,
            reason: `Reconciled Exactly | Mapped Status: ${mappedV2State}`
        };
    }

    static _fail(reason, v2Total = 0) {
        return {
            status: 'MIGRATION_FAILED -> FROZEN',
            v2Principal: 0,
            v2Interest: 0,
            v2Fees: 0,
            v2Total: v2Total, // Capture calculated total for accurate diff
            v2LedgerSum: 0,
            reason
        };
    }
}

module.exports = V1_V2_Migration;
