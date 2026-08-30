require('dotenv').config();
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const FinancialLedgerService = require('../services/FinancialLedgerService');
const Loan = require('../models/Loan');
const Transaction = require('../models/Transaction');

async function runTests() {
    console.log("Starting In-Memory Replica Set...");
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    
    console.log("Connecting to Memory DB:", uri);
    await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
    
    console.log("\n--- STARTING PHASE 2 INVARIANT TESTS ---");

    try {
        await testConcurrency();
        await testLifecycle();
        console.log("\n🟢 ALL PHASE 2 TESTS PASSED");
    } catch (err) {
        console.error("\n🔴 TEST FAILED:", err);
    } finally {
        await mongoose.disconnect();
        await replSet.stop();
    }
}

async function testConcurrency() {
    console.log("\n[TEST] 100 Concurrent Payments");
    
    // Setup Loan (Simulate an existing V2 loan)
    const loan = new Loan({
        lender: new mongoose.Types.ObjectId().toString(), 
        borrowerName: 'Borrower 1', 
        borrowerPhone: '123', 
        amount: 1000000, 
        durationMonths: 12,
        ledgerVersion: 2, 
        principalOutstandingPaise: 10000, 
        interestOutstandingPaise: 0, 
        feesOutstandingPaise: 0,
        status: 'active'
    });
    await loan.save();

    // 100 concurrent requests of Rs. 7000 (7000 paise in this test context) against 10000 balance
    const paymentAmount = 7000;
    
    const promises = [];
    for (let i = 0; i < 100; i++) {
        promises.push(
            FinancialLedgerService.recordPayment(loan._id, paymentAmount, 'actor1').catch(e => e.message)
        );
    }

    const results = await Promise.all(promises);
    
    const successes = results.filter(r => typeof r === 'object' && r.transaction);
    const overpaymentErrors = results.filter(r => typeof r === 'string' && r.includes('OVERPAYMENT'));
    
    console.log(`Successes: ${successes.length}`);
    console.log(`Overpayment Errors: ${overpaymentErrors.length}`);
    
    if (successes.length !== 1) {
        throw new Error(`Expected exactly 1 success, got ${successes.length}`);
    }

    const updatedLoan = await Loan.findById(loan._id);
    console.log(`Final Principal: ${updatedLoan.principalOutstandingPaise} (Expected: 3000)`);
    
    if (updatedLoan.principalOutstandingPaise < 0) {
         throw new Error(`Negative balance: ${updatedLoan.principalOutstandingPaise}`);
    }

    const txs = await Transaction.find({ loanId: loan._id });
    const seqs = new Set(txs.map(t => t.sequenceNumber));
    if (seqs.size !== txs.length) throw new Error("Duplicate sequence numbers detected");

    const totalPrincipal = txs.reduce((sum, t) => sum + t.principalDeltaPaise, 0);
    console.log(`Ledger Principal Sum: ${totalPrincipal} | Cache: ${updatedLoan.principalOutstandingPaise}`);

    // Adjusting for the initial 10000 balance which wasn't a tx in this test setup:
    if (10000 + totalPrincipal !== updatedLoan.principalOutstandingPaise) {
        throw new Error("Ledger mismatch");
    }

    console.log("✅ Concurrency Test Passed");
}

async function testLifecycle() {
    console.log("\n[TEST] Grand Lifecycle & Invariant Verification");

    const loanId = new mongoose.Types.ObjectId();
    const lenderId = new mongoose.Types.ObjectId().toString();

    const loan = new Loan({
        _id: loanId,
        lender: lenderId, borrowerName: 'Borrower 2', borrowerPhone: '123', amount: 1000, durationMonths: 12,
        ledgerVersion: 2, status: 'pending_approval' 
    });
    await loan.save();

    console.log("-> Create Loan (100000 paise)");
    await FinancialLedgerService.createLoan(loan._id, 100000, lenderId, {
        interestRateBps: 1200, interestMethod: 'SIMPLE_ORIGINAL_PRINCIPAL', expectedPrincipalPaise: 100000
    });
    
    await Loan.updateOne({ _id: loan._id }, { status: 'active' });

    console.log("-> Accrue Interest (3 days)");
    const start = new Date("2026-08-01T00:00:00Z");
    const end = new Date("2026-08-04T00:00:00Z");
    await FinancialLedgerService.accrueInterest(loan._id, "period1", start, end);

    console.log("-> Assess Fee (500 paise)");
    await FinancialLedgerService.assessFee(loan._id, 500, lenderId);

    console.log("-> Pay 2000 paise");
    const pay1 = await FinancialLedgerService.recordPayment(loan._id, 2000, 'borrower1');

    console.log("-> Add Credit 50000 paise");
    await FinancialLedgerService.addCredit(loan._id, 50000, 'intent1', lenderId);

    console.log("-> Pay 10000 paise");
    await FinancialLedgerService.recordPayment(loan._id, 10000, 'borrower1');

    console.log("-> Reverse First Payment");
    await FinancialLedgerService.reverseTransaction(loan._id, pay1.transaction.transactionId, lenderId);

    console.log("-> Write Off & Close");
    await FinancialLedgerService.writeOffAndClose(loan._id, lenderId);

    // Independent Reconciliation
    console.log("\nRunning Independent Reconciliation...");
    const updatedLoan = await Loan.findById(loan._id);
    const txs = await Transaction.find({ loanId: loan._id });
    
    let calcP = 0, calcI = 0, calcF = 0;
    txs.forEach(t => {
        calcP += t.principalDeltaPaise;
        calcI += t.interestDeltaPaise;
        calcF += t.feeDeltaPaise;
    });

    console.log(`Calculated Principal: ${calcP} | Cached: ${updatedLoan.principalOutstandingPaise}`);
    console.log(`Calculated Interest: ${calcI} | Cached: ${updatedLoan.interestOutstandingPaise}`);
    console.log(`Calculated Fees: ${calcF} | Cached: ${updatedLoan.feesOutstandingPaise}`);
    console.log(`Final Loan Status: ${updatedLoan.status}`);

    if (calcP !== updatedLoan.principalOutstandingPaise || 
        calcI !== updatedLoan.interestOutstandingPaise || 
        calcF !== updatedLoan.feesOutstandingPaise) {
        throw new Error("RECONCILIATION FAILED");
    }
    
    if (updatedLoan.status !== 'closed') {
        throw new Error("Loan not closed: " + updatedLoan.status);
    }

    console.log("✅ Grand Lifecycle Test Passed");
}

runTests();
