const assert = require('assert');
const FinancialLedgerService = require('../services/FinancialLedgerService');

async function runTests() {
    console.log('Running V2 Ledger Tests...');

    let loan = {
        amount: 1000,
        transactions: [],
        interestRate: 12, // 12% per year -> 1% per month -> 12% per year
        durationMonths: 12,
        durationType: 'Months'
    };

    const startDate = new Date('2023-01-01T00:00:00Z');
    
    // 1. Activation
    console.log('[TEST] Loan activation creates opening V2 ledger transaction');
    await FinancialLedgerService.activateLoan(loan, 100000, 'lender_id', startDate);
    assert.strictEqual(loan.transactions.length, 1);
    assert.strictEqual(loan.transactions[0].type, 'loan_given');
    assert.strictEqual(loan.principalOutstandingPaise, 100000);
    console.log('✅ Pass');

    // 2. Accrual before payment
    console.log('[TEST] Interest accrued before payment');
    // Let's say 30 days passed
    const paymentDate = new Date('2023-01-31T00:00:00Z');
    // Rate = 12% monthly. Annual = 144%. Principal = 100000. Days = 30.
    // Interest = floor( (100000 * (12 * 12) * 30) / (365 * 100) ) = 11835
    
    await FinancialLedgerService.recordPayment(loan, 50000, 'intent_1', 'lender_id', paymentDate);
    
    assert.strictEqual(loan.transactions.length, 3); // loan_given, interest_accrued, payment
    assert.strictEqual(loan.transactions[1].type, 'interest_accrued');
    assert.strictEqual(loan.transactions[1].amountPaise, 11835);
    console.log('✅ Pass');

    // 3. Payment waterfall
    console.log('[TEST] Payment waterfall fees -> interest -> principal');
    assert.strictEqual(loan.transactions[2].type, 'payment');
    // Payment was 50000. Interest was 11835. Fees 0.
    // So 11835 to interest, 38165 to principal.
    assert.strictEqual(loan.transactions[2].interestAllocationPaise, 11835);
    assert.strictEqual(loan.transactions[2].principalAllocationPaise, 38165);
    assert.strictEqual(loan.transactions[2].feesAllocationPaise, 0);
    assert.strictEqual(loan.interestOutstandingPaise, 0);
    assert.strictEqual(loan.principalOutstandingPaise, 100000 - 38165); // 61835
    console.log('✅ Pass');

    // 4. Overpayment rejection
    console.log('[TEST] Overpayment rejected');
    let overpaymentRejected = false;
    try {
        await FinancialLedgerService.recordPayment(loan, 99999999, 'intent_bad', 'lender_id', paymentDate);
    } catch (e) {
        overpaymentRejected = true;
    }
    assert.strictEqual(overpaymentRejected, true);
    console.log('✅ Pass');

    // 5. Add Credit after accrued interest
    console.log('[TEST] Add Credit after accrued interest');
    // Fast forward 10 days
    const creditDate = new Date('2023-02-10T00:00:00Z');
    // Principal = 61835. Days = 10. Rate = 12% (144% annual).
    // Interest = floor( (61835 * 144 * 10) / (365 * 100) ) = 2439
    
    await FinancialLedgerService.addCredit(loan, 10000, 'intent_2', 'lender_id', creditDate);
    
    assert.strictEqual(loan.transactions.length, 5); // ... + interest_accrued, credit_added
    assert.strictEqual(loan.transactions[3].type, 'interest_accrued');
    assert.strictEqual(loan.transactions[3].amountPaise, 2439);
    assert.strictEqual(loan.interestOutstandingPaise, 2439);
    assert.strictEqual(loan.principalOutstandingPaise, 61835 + 10000); // 71835
    console.log('✅ Pass');

    // 6. Idempotency
    console.log('[TEST] Duplicate/idempotent payment request');
    const oldTxnCount = loan.transactions.length;
    await FinancialLedgerService.addCredit(loan, 10000, 'intent_2', 'lender_id', creditDate);
    assert.strictEqual(loan.transactions.length, oldTxnCount);
    console.log('✅ Pass');

    // 7. Payment exactly equal to outstanding
    console.log('[TEST] Payment exactly equal to outstanding');
    const totalOutstanding = loan.principalOutstandingPaise + loan.interestOutstandingPaise + loan.feesOutstandingPaise;
    await FinancialLedgerService.recordPayment(loan, totalOutstanding, 'intent_3', 'lender_id', creditDate);
    assert.strictEqual(loan.principalOutstandingPaise, 0);
    assert.strictEqual(loan.interestOutstandingPaise, 0);
    assert.strictEqual(loan.status, 'completed');
    console.log('✅ Pass');

    console.log('\nAll V2 Ledger Tests Passed! 🎉');
}

runTests().catch(console.error);
