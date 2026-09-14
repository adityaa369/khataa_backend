const crypto = require('crypto');

class ProductionMigrationAnalyzer {
    /**
     * Executes purely in-memory. NO database mutations.
     */
    static runAnalysis(loans) {
        const report = {
            counts: { total: 0, migratable: 0, failed: 0, skipped: 0 },
            money: { v1Eligible: 0, v2Reconstructed: 0, v1Failed: 0 },
            transactions: { totalV1: 0, mappedV2: 0, unmapped: 0 },
            taxonomy: {
                DATA_CORRUPTION: 0,
                UNSUPPORTED_LEGACY_SEMANTICS: 0,
                AMBIGUOUS_RECONSTRUCTION: 0,
                SCHEMA_ERROR: 0,
                STATE_ERROR: 0
            },
            representativeFailures: [],
            fingerprints: { before: null, after: null }
        };

        // 1. Zero-Mutation Proof: Before Fingerprint
        report.fingerprints.before = this.generateFingerprint(loans);

        for (const v1Loan of loans) {
            report.counts.total++;
            
            const v1Expected = v1Loan.totalPayablePaise || 0;
            const txs = v1Loan.transactions || [];
            report.transactions.totalV1 += txs.length;

            if (v1Loan.ledgerVersion === 2) {
                report.counts.skipped++;
                continue;
            }

            const result = this.analyzeSingleLoan(v1Loan);

            if (result.status === 'MIGRATABLE') {
                report.counts.migratable++;
                report.money.v1Eligible += v1Expected;
                report.money.v2Reconstructed += result.v2Total;
                report.transactions.mappedV2 += result.mappedTxs;
            } else {
                report.counts.failed++;
                report.money.v1Failed += v1Expected;
                report.transactions.unmapped += result.unmappedTxs;
                report.taxonomy[result.taxonomy]++;
                
                // Keep one example per taxonomy
                if (report.representativeFailures.filter(f => f.taxonomy === result.taxonomy).length < 2) {
                    report.representativeFailures.push({
                        loanId: v1Loan._id,
                        taxonomy: result.taxonomy,
                        reason: result.reason,
                        v1State: v1Loan.status,
                        v1Total: v1Expected,
                        transactions: txs.length
                    });
                }
            }
        }

        // 2. Zero-Mutation Proof: After Fingerprint
        report.fingerprints.after = this.generateFingerprint(loans);

        return report;
    }

    static generateFingerprint(loans) {
        const hash = crypto.createHash('sha256');
        for (const l of loans) {
            hash.update(l._id + (l.amountPaise||0) + (l.totalPayablePaise||0) + l.status + (l.transactions?l.transactions.length:0));
        }
        return hash.digest('hex');
    }

    static analyzeSingleLoan(v1Loan) {
        const txs = v1Loan.transactions || [];
        const isPreActive = ['pending', 'pending_approval', 'rejected', 'cancelled', 'expired'].includes(v1Loan.status);
        
        let p = 0, i = 0, f = 0;
        let mappedTxs = 0;

        // --- PRE-ACTIVE VALIDATION ---
        if (isPreActive) {
            if (v1Loan.totalPayablePaise > 0) {
                return this._fail('STATE_ERROR', `Pre-active loan (${v1Loan.status}) has non-zero totalPayablePaise: ${v1Loan.totalPayablePaise}`, txs.length);
            }
            if (txs.length > 0) {
                return this._fail('STATE_ERROR', `Pre-active loan (${v1Loan.status}) contains transactions.`, txs.length);
            }
        } else {
            if (v1Loan.amountPaise === undefined) return this._fail('SCHEMA_ERROR', 'Missing amountPaise on active loan', txs.length);
            p = v1Loan.amountPaise;
        }

        let paidAmountPaiseAcc = 0;
        const txHistory = [];

        // Chronological sort
        txs.sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));

        for (const tx of txs) {
            if (tx.amountPaise === undefined) return this._fail('SCHEMA_ERROR', 'Transaction missing amountPaise', txs.length);
            
            txHistory.push(tx);
            mappedTxs++;

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
                    f -= feeAlloc; remaining -= feeAlloc;
                    
                    const intAlloc = Math.min(remaining, i);
                    i -= intAlloc; remaining -= intAlloc;
                    
                    const pAlloc = Math.min(remaining, p);
                    p -= pAlloc; remaining -= pAlloc;
                    
                    if (remaining > 0) return this._fail('AMBIGUOUS_RECONSTRUCTION', `Overpayment detected. Remaining: ${remaining}`, txs.length);
                    break;
                case 'payment_reversed':
                    // Ambiguous Reversal Check
                    const matchingPayments = txHistory.filter(t => t.type === 'payment' && t.amountPaise === tx.amountPaise);
                    if (matchingPayments.length > 1 && !tx.referenceTxId) {
                        return this._fail('AMBIGUOUS_RECONSTRUCTION', `Multiple payments of ${tx.amountPaise} exist with no strict reference ID for reversal.`, txs.length);
                    }
                    if (matchingPayments.length === 0) {
                        return this._fail('DATA_CORRUPTION', `Reversal of ${tx.amountPaise} found, but no preceding payment exists.`, txs.length);
                    }
                    p += tx.amountPaise;
                    paidAmountPaiseAcc -= tx.amountPaise;
                    break;
                case 'write_off':
                    p = 0; i = 0; f = 0;
                    break;
                default:
                    return this._fail('UNSUPPORTED_LEGACY_SEMANTICS', `Unknown transaction type: ${tx.type}`, txs.length);
            }

            if (p < 0 || i < 0 || f < 0) return this._fail('DATA_CORRUPTION', 'Negative balance reached during chronological replay', txs.length);
        }

        // Silent unrecorded payments check
        if (v1Loan.paidAmountPaise !== undefined && v1Loan.paidAmountPaise !== paidAmountPaiseAcc) {
            return this._fail('DATA_CORRUPTION', `paidAmountPaise (${v1Loan.paidAmountPaise}) != tx sum (${paidAmountPaiseAcc})`, txs.length);
        }

        const v2Total = p + i + f;
        const v1Expected = v1Loan.totalPayablePaise || 0;
        
        if (v2Total !== v1Expected) {
            return this._fail('DATA_CORRUPTION', `RECONCILIATION_MISMATCH: V1=${v1Expected} vs V2=${v2Total}`, txs.length);
        }

        let mappedV2State = 'ACTIVE';
        if (isPreActive) mappedV2State = v1Loan.status.toUpperCase();
        else if (v2Total === 0 && txs.some(t => t.type === 'write_off')) mappedV2State = 'CLOSED';
        else if (v2Total === 0) mappedV2State = 'COMPLETED';

        return {
            status: 'MIGRATABLE',
            v2Principal: p,
            v2Interest: i,
            v2Fees: f,
            v2Total: v2Total,
            mappedTxs: mappedTxs,
            mappedV2State: mappedV2State
        };
    }

    static _fail(taxonomy, reason, unmappedCount) {
        return {
            status: 'FAILED',
            taxonomy,
            reason,
            unmappedTxs: unmappedCount
        };
    }
}

module.exports = ProductionMigrationAnalyzer;
