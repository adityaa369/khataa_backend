/**
 * Phase 4E: V1 Purge Final Integration & Ledger Re-construction Tests
 *
 * Verifies that the V2 pipeline correctly processes HAND, BUSINESS, and INTEREST loans,
 * and that all legacy side-effects (custom_transactions, totalPayable, etc.) are absent.
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const connectDB = require('../config/db');

// Models
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');
const TransactionIntent = require('../models/TransactionIntent');
const User = require('../models/User');

// Services
const FLS = require('../services/FinancialLedgerService');

async function setupTestUsers() {
    let lender = await User.findOne({ phone: '+919999999991' });
    if (!lender) lender = await User.create({
        id: 'LENDER_ID_1', phone: '+919999999991', email: 'lender@test.com', firstName: 'Lender', isEmailVerified: true, kycStatus: 'COMPLETED'
    });

    let borrower = await User.findOne({ phone: '+919999999992' });
    if (!borrower) borrower = await User.create({
        id: 'BORROWER_ID_1', phone: '+919999999992', email: 'borrower@test.com', firstName: 'Borrower', isEmailVerified: true, kycStatus: 'COMPLETED'
    });
    
    return { lender, borrower };
}

async function verifyZeroLegacySideEffects(loanId) {
    // We fetch a raw doc to see exactly what is in MongoDB (bypass mongoose schema defaults)
    const rawLoan = await Loan.collection.findOne({ _id: loanId });
    
    const violations = [];
    if (rawLoan.custom_transactions && rawLoan.custom_transactions.length > 0) violations.push('custom_transactions is populated');
    if (rawLoan.transactions && rawLoan.transactions.length > 0) violations.push('transactions (embedded) is populated');
    if ('totalPayable' in rawLoan) violations.push('totalPayable exists');
    if ('totalPayablePaise' in rawLoan) violations.push('totalPayablePaise exists');
    if ('paidAmount' in rawLoan) violations.push('paidAmount exists');
    if ('paidAmountPaise' in rawLoan) violations.push('paidAmountPaise exists');

    return violations;
}

async function verifyLedgerReconstruction(loanId) {
    const loan = await Loan.findById(loanId);
    const transactions = await Transaction.find({ loanId }).sort({ sequenceNumber: 1 });
    
    let computedPrincipal = loan.expectedPrincipalPaise || 0;
    let computedInterest = 0;
    let computedFees = 0;
    let hasLoanCreated = false;

    for (const tx of transactions) {
        if (tx.type === 'LOAN_CREATED') hasLoanCreated = true;
        computedPrincipal += (tx.principalDeltaPaise || 0);
        computedInterest += (tx.interestDeltaPaise || 0);
        computedFees += (tx.feeDeltaPaise || 0);
    }
    
    const errors = [];
    if (!hasLoanCreated) errors.push('Missing LOAN_CREATED transaction');
    if (computedPrincipal !== loan.principalOutstandingPaise) errors.push(`Principal mismatch: ledger=${computedPrincipal}, cache=${loan.principalOutstandingPaise}`);
    if (computedInterest !== loan.interestOutstandingPaise) errors.push(`Interest mismatch: ledger=${computedInterest}, cache=${loan.interestOutstandingPaise}`);
    if (computedFees !== loan.feesOutstandingPaise) errors.push(`Fees mismatch: ledger=${computedFees}, cache=${loan.feesOutstandingPaise}`);

    return { success: errors.length === 0, errors };
}

async function simulateLoanLifecycle(creditType, lender, borrower) {
    console.log(`\n--- Simulating Lifecycle for ${creditType} ---`);

    // 1. Create
    const loan = await Loan.create({
        lender: lender.id, // Using string 'id' for lender/borrower references based on other files
        borrower: borrower.id,
        borrowerName: borrower.firstName,
        borrowerPhone: borrower.phone,
        amount: 1000,
        amountPaise: 100000,
        creditType: creditType,
        interestRateBps: creditType === 'INTEREST_CREDIT' ? 2400 : 0, // 24% for interest credit
        durationMonths: 12,
        status: 'pending_approval'
    });
    console.log(`[1] Created Loan ${loan._id}`);

    // 2. Accept (Intent + OTP bypass -> FLS.acceptLoan)
    // Controller would create intent. We simulate service layer call.
    const intent = await TransactionIntent.create({
        intentId: 'test_intent_' + Date.now(),
        userId: borrower.id, // using .id
        loanId: loan._id,
        action: 'ACCEPT_LOAN',
        payload: { amountPaise: loan.amountPaise }, // Added payload
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 1000 * 60 * 15)
    });
    await FLS.acceptLoan(loan._id, borrower.id, intent.intentId);
    console.log(`[2] Accepted Loan (FLS.acceptLoan)`);

    // 3. Payment
    const paymentIntent = await TransactionIntent.create({
        intentId: 'test_intent_' + Date.now() + 1,
        userId: lender.id,
        loanId: loan._id,
        action: 'RECORD_PAYMENT',
        payload: { amountPaise: 20000 },
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 1000 * 60 * 15)
    });
    await FLS.recordPayment(loan._id, 20000, lender.id, paymentIntent.intentId);
    console.log(`[3] Recorded Payment of 20000 paise (FLS.recordPayment)`);

    // 4. Add Credit
    const addCreditIntent = await TransactionIntent.create({
        intentId: 'test_intent_' + Date.now() + 2,
        userId: lender.id,
        loanId: loan._id,
        action: 'ADD_CREDIT',
        payload: { amountPaise: 50000 },
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 1000 * 60 * 15)
    });
    await FLS.addCredit(loan._id, 50000, lender.id, addCreditIntent.intentId);
    console.log(`[4] Added Credit of 50000 paise (FLS.addCredit)`);

    // 5. Verification Phase
    const legacyViolations = await verifyZeroLegacySideEffects(loan._id);
    const ledgerIntegrity = await verifyLedgerReconstruction(loan._id);

    if (legacyViolations.length > 0) {
        console.error(`❌ Legacy violations found: ${legacyViolations.join(', ')}`);
        return false;
    } else {
        console.log(`✅ Zero legacy side effects`);
    }

    if (!ledgerIntegrity.success) {
        console.error(`❌ Ledger reconstruction failed: ${ledgerIntegrity.errors.join(', ')}`);
        return false;
    } else {
        console.log(`✅ Ledger reconstruction perfect`);
    }

    return true;
}

const { MongoMemoryReplSet } = require('mongodb-memory-server');

async function runIntegrationTests() {
    let replSet;
    try {
        console.log("Starting In-Memory Replica Set...");
        replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
        const uri = replSet.getUri();
        await mongoose.connect(uri);
        
        const { lender, borrower } = await setupTestUsers();

        const results = {
            HAND: false,
            BUSINESS: false,
            INTEREST: false
        };

        results.HAND = await simulateLoanLifecycle('HAND_CREDIT', lender, borrower);
        results.BUSINESS = await simulateLoanLifecycle('BUSINESS_CREDIT', lender, borrower);
        results.INTEREST = await simulateLoanLifecycle('INTEREST_CREDIT', lender, borrower);

        console.log('\n=============================================================');
        console.log('  INTEGRATION TEST RESULTS');
        console.log('=============================================================');
        console.log(`HAND_CREDIT:      ${results.HAND ? '🟢 PASS' : '🔴 FAIL'}`);
        console.log(`BUSINESS_CREDIT:  ${results.BUSINESS ? '🟢 PASS' : '🔴 FAIL'}`);
        console.log(`INTEREST_CREDIT:  ${results.INTEREST ? '🟢 PASS' : '🔴 FAIL'}`);

        if (results.HAND && results.BUSINESS && results.INTEREST) {
            console.log('\n✅ ALL INTEGRATION TESTS PASSED');
            process.exit(0);
        } else {
            console.log('\n❌ SOME TESTS FAILED');
            process.exit(1);
        }

    } catch (e) {
        console.error('Fatal Error:', e);
        process.exit(1);
    } finally {
        if (mongoose.connection) await mongoose.connection.close();
        if (replSet) await replSet.stop();
    }
}

runIntegrationTests();
