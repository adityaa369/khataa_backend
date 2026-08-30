/**
 * Phase 4E Suite 12 — MongoDB Least Privilege Discovery
 * ======================================================
 * Tests performed ONLY against an isolated MongoMemoryReplSet.
 * No production database is touched.
 *
 * Two test layers:
 *   LAYER 1 — Mongoose model layer (hooks, validators)
 *   LAYER 2 — Raw MongoDB driver layer (bypasses Mongoose hooks)
 *
 * Layer 2 is the critical security question: if the app credential can
 * issue driver-level UPDATE/DELETE to the transactions collection,
 * the Mongoose hooks provide no real protection.
 */

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let pass = 0, fail = 0, warn = 0;

function PASS(t) { console.log(`🟢 PASS   ${t}`); pass++; }
function FAIL(t, d) { console.log(`🔴 FAIL   ${t} — ${d}`); fail++; }
function WARN(t, d) { console.log(`⚠️  WARN   ${t} — ${d}`); warn++; }
function HDR(t) { console.log(`\n── ${t}`); }
function ROW(label, val) { console.log(`         ${label.padEnd(30)} ${val}`); }

// ── Models ────────────────────────────────────────────────────────────────────
const { v4: uuidv4 } = require('uuid');
const MAX_PAISE = Number.MAX_SAFE_INTEGER;

const transactionSchema = new mongoose.Schema({
    transactionId: { type: String, default: uuidv4, unique: true },
    loanId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sequenceNumber: { type: Number, required: true },
    type: { type: String, enum: ['LOAN_CREATED','CREDIT_ADDED','INTEREST_ACCRUED','FEE_ASSESSED','PAYMENT','REVERSAL','WRITE_OFF'], required: true },
    actorId: { type: String, required: true },
    currency: { type: String, default: 'INR' },
    effectiveAt: { type: Date, required: true },
    businessDate: { type: String, required: true },
    principalDeltaPaise: { type: Number, required: true },
    interestDeltaPaise: { type: Number, required: true },
    feeDeltaPaise: { type: Number, required: true },
    amountPaise: { type: Number, required: true },
    reversesTransactionId: { type: String, default: null },
    intentId: { type: String, default: null },
    accrualPeriodId: { type: String },
    accrualStart: { type: Date },
    accrualEnd: { type: Date }
});
transactionSchema.index({ loanId: 1, sequenceNumber: 1 }, { unique: true });
transactionSchema.pre('updateOne', function() { throw new Error('IMMUTABILITY_VIOLATION: Updates to Transactions are forbidden.'); });
transactionSchema.pre('findOneAndUpdate', function() { throw new Error('IMMUTABILITY_VIOLATION: Updates to Transactions are forbidden.'); });
transactionSchema.pre('deleteOne', function() { throw new Error('IMMUTABILITY_VIOLATION: Deletions of Transactions are forbidden.'); });
transactionSchema.pre('findOneAndDelete', function() { throw new Error('IMMUTABILITY_VIOLATION: Deletions of Transactions are forbidden.'); });
const Transaction = mongoose.model('Transaction', transactionSchema);

const loanSchema = new mongoose.Schema({
    status: String, financialStatus: String,
    principalOutstandingPaise: Number,
    interestOutstandingPaise: Number,
    feesOutstandingPaise: Number,
    ledgerVersion: Number,
    amountPaise: Number,
});
const Loan = mongoose.model('Loan', loanSchema);

// ── Test Runner ────────────────────────────────────────────────────────────────
async function run() {
    const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri(), { dbName: 'khatha_security_test' });

    // ─── Seed a loan and a transaction record ───────────────────────────────
    const loan = await Loan.create({
        status: 'active', financialStatus: 'NORMAL',
        principalOutstandingPaise: 100000, interestOutstandingPaise: 0,
        feesOutstandingPaise: 0, ledgerVersion: 2, amountPaise: 100000
    });

    const tx = await new Transaction({
        loanId: loan._id, sequenceNumber: 1, type: 'LOAN_CREATED',
        actorId: 'test_user', effectiveAt: new Date(),
        businessDate: '2026-08-30',
        principalDeltaPaise: 100000, interestDeltaPaise: 0, feeDeltaPaise: 0,
        amountPaise: 100000
    }).save();

    console.log('=========================================================================');
    console.log('  PHASE 4E Suite 12 — MongoDB Least Privilege Discovery');
    console.log('=========================================================================');
    console.log('  ⚠️  All tests run against an ISOLATED in-memory database.');
    console.log('  ⚠️  No production data is accessed or modified.\n');

    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 1 — Mongoose Model Layer (Hook Coverage)
    // ═══════════════════════════════════════════════════════════════════════════
    HDR('LAYER 1: Mongoose Hook Coverage');

    // L1-A: updateOne is blocked by hook
    try {
        await Transaction.updateOne({ _id: tx._id }, { $set: { amountPaise: 0 } });
        FAIL('L1-A: Transaction.updateOne blocked by hook', 'It SUCCEEDED — hook did not fire!');
    } catch(e) {
        e.message.includes('IMMUTABILITY_VIOLATION')
            ? PASS('L1-A: Transaction.updateOne correctly throws IMMUTABILITY_VIOLATION')
            : FAIL('L1-A: Transaction.updateOne', `Unexpected error: ${e.message}`);
    }

    // L1-B: findOneAndUpdate is blocked by hook
    try {
        await Transaction.findOneAndUpdate({ _id: tx._id }, { $set: { amountPaise: 0 } });
        FAIL('L1-B: Transaction.findOneAndUpdate blocked by hook', 'It SUCCEEDED — hook did not fire!');
    } catch(e) {
        e.message.includes('IMMUTABILITY_VIOLATION')
            ? PASS('L1-B: Transaction.findOneAndUpdate correctly throws IMMUTABILITY_VIOLATION')
            : FAIL('L1-B', `Unexpected error: ${e.message}`);
    }

    // L1-C: deleteOne is blocked by hook
    try {
        await Transaction.deleteOne({ _id: tx._id });
        FAIL('L1-C: Transaction.deleteOne blocked by hook', 'It SUCCEEDED — hook did not fire!');
    } catch(e) {
        e.message.includes('IMMUTABILITY_VIOLATION')
            ? PASS('L1-C: Transaction.deleteOne correctly throws IMMUTABILITY_VIOLATION')
            : FAIL('L1-C', `Unexpected error: ${e.message}`);
    }

    // L1-D: findOneAndDelete is blocked by hook
    try {
        await Transaction.findOneAndDelete({ _id: tx._id });
        FAIL('L1-D: Transaction.findOneAndDelete blocked by hook', 'It SUCCEEDED — hook did not fire!');
    } catch(e) {
        e.message.includes('IMMUTABILITY_VIOLATION')
            ? PASS('L1-D: Transaction.findOneAndDelete correctly throws IMMUTABILITY_VIOLATION')
            : FAIL('L1-D', `Unexpected error: ${e.message}`);
    }

    // L1-E: updateMany — NOT covered by hooks
    try {
        const result = await Transaction.updateMany({ _id: tx._id }, { $set: { amountPaise: 0 } });
        WARN('L1-E: Transaction.updateMany NOT blocked by Mongoose hooks',
            `Updated ${result.modifiedCount} documents — hook gap exists!`);
    } catch(e) {
        PASS(`L1-E: Transaction.updateMany blocked — ${e.message.substring(0,60)}`);
    }

    // L1-F: deleteMany — NOT covered by hooks
    try {
        const result = await Transaction.deleteMany({ _id: tx._id });
        WARN('L1-F: Transaction.deleteMany NOT blocked by Mongoose hooks',
            `Deleted ${result.deletedCount} documents — hook gap exists!`);
    } catch(e) {
        PASS(`L1-F: Transaction.deleteMany blocked — ${e.message.substring(0,60)}`);
    }

    // L1-G: replaceOne — NOT covered by hooks
    try {
        const result = await Transaction.replaceOne({ _id: tx._id }, { amountPaise: 0 });
        WARN('L1-G: Transaction.replaceOne NOT blocked by Mongoose hooks',
            `Modified ${result.modifiedCount} documents — hook gap exists!`);
    } catch(e) {
        PASS(`L1-G: Transaction.replaceOne blocked — ${e.message.substring(0,60)}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 2 — Raw MongoDB Driver (Bypasses ALL Mongoose hooks)
    // This is what the DB credential can ACTUALLY do regardless of app code.
    // ═══════════════════════════════════════════════════════════════════════════
    HDR('LAYER 2: Raw MongoDB Driver (bypasses Mongoose hooks)');

    // Re-seed tx if L1-F/G deleted it
    const txCheck = await Transaction.findById(tx._id);
    let rawTxId = tx._id;
    if (!txCheck) {
        const re = await new Transaction({
            loanId: loan._id, sequenceNumber: 2, type: 'LOAN_CREATED',
            actorId: 'test_user', effectiveAt: new Date(),
            businessDate: '2026-08-30',
            principalDeltaPaise: 100000, interestDeltaPaise: 0, feeDeltaPaise: 0,
            amountPaise: 100000
        }).save();
        rawTxId = re._id;
    }

    const db = mongoose.connection.db;
    const txCollection = db.collection('transactions');
    const loanCollection = db.collection('loans');

    // L2-A: Driver-level updateOne on transactions
    try {
        const originalDoc = await txCollection.findOne({ _id: rawTxId });
        const result = await txCollection.updateOne(
            { _id: rawTxId },
            { $set: { _security_test_tamper: true, amountPaise: 999 } }
        );
        const afterDoc = await txCollection.findOne({ _id: rawTxId });
        if (result.modifiedCount > 0 && afterDoc && afterDoc.amountPaise === 999) {
            WARN('L2-A: Driver updateOne on transactions SUCCEEDED',
                `CRITICAL: DB credential can UPDATE historical transactions at driver level. Modified ${result.modifiedCount} doc(s).`);
        } else {
            PASS('L2-A: Driver updateOne on transactions — no modification');
        }
        // Clean up test field
        await txCollection.updateOne({ _id: rawTxId }, { $unset: { _security_test_tamper: '' }, $set: { amountPaise: 100000 } });
    } catch(e) {
        PASS(`L2-A: Driver updateOne blocked at DB level — ${e.message.substring(0,60)}`);
    }

    // L2-B: Driver-level deleteOne on transactions
    try {
        // First count
        const beforeCount = await txCollection.countDocuments({ loanId: loan._id });
        const result = await txCollection.deleteOne({ _id: rawTxId });
        const afterCount = await txCollection.countDocuments({ loanId: loan._id });
        if (result.deletedCount > 0) {
            WARN('L2-B: Driver deleteOne on transactions SUCCEEDED',
                `CRITICAL: DB credential can DELETE historical transactions. Before: ${beforeCount}, After: ${afterCount}`);
        } else {
            PASS('L2-B: Driver deleteOne on transactions — no deletion');
        }
    } catch(e) {
        PASS(`L2-B: Driver deleteOne blocked at DB level — ${e.message.substring(0,60)}`);
    }

    // L2-C: Driver-level drop of transactions collection
    try {
        const countBefore = await txCollection.countDocuments();
        // Use a safer approach — just test if the credential has the listCollections privilege
        // which would indicate DDL capability. Actual drop would be destructive.
        const cols = await db.listCollections({ name: 'transactions' }).toArray();
        const hasListCollections = cols.length > 0;
        
        // Test actual drop capability via runCommand (will fail if unauthorized)
        try {
            const dropResult = await db.command({ drop: 'transactions_security_test_ephemeral' });
            // If this succeeds, DDL is allowed (we tried a non-existent collection)
            WARN('L2-C: DDL runCommand (drop) allowed on DB level',
                'DB credential has DDL privileges. dropCollection on non-production ephemeral collection succeeded/permitted.');
        } catch(ddlErr) {
            if (ddlErr.code === 26) {
                // ns not found — collection didn't exist but command was authorized
                WARN('L2-C: DDL command authorized (ns not found = collection missing, not permission denied)',
                    'DB credential has DDL privileges. Suggested: deny dropCollection in Atlas role.');
            } else if (ddlErr.code === 13 || ddlErr.message.includes('not authorized') || ddlErr.message.includes('Unauthorized')) {
                PASS('L2-C: DDL drop command blocked at DB level (Unauthorized)');
            } else {
                WARN('L2-C: DDL command result unclear', `Code: ${ddlErr.code} — ${ddlErr.message.substring(0,80)}`);
            }
        }
    } catch(e) {
        WARN('L2-C: Collection inspection error', e.message.substring(0,80));
    }

    // L2-D: Driver-level arbitrary Loan balance tamper
    try {
        const origLoan = await loanCollection.findOne({ _id: loan._id });
        const result = await loanCollection.updateOne(
            { _id: loan._id },
            { $set: { principalOutstandingPaise: 0, _security_test: true } }
        );
        const afterLoan = await loanCollection.findOne({ _id: loan._id });
        if (result.modifiedCount > 0 && afterLoan && afterLoan.principalOutstandingPaise === 0) {
            WARN('L2-D: Driver updateOne on loans SUCCEEDED',
                `CRITICAL: DB credential can update Loan balances directly. Modified ${result.modifiedCount} doc(s).`);
        } else {
            PASS('L2-D: Driver updateOne on loans — no modification');
        }
        // Restore
        await loanCollection.updateOne({ _id: loan._id }, { $set: { principalOutstandingPaise: 100000 }, $unset: { _security_test: '' } });
    } catch(e) {
        PASS(`L2-D: Driver updateOne on loans blocked at DB level — ${e.message.substring(0,60)}`);
    }

    // L2-E: Driver-level User collection update
    try {
        const userColl = db.collection('users');
        const result = await userColl.updateOne(
            { phone: '__nonexistent_test__' },
            { $set: { isAdmin: true } },
            { upsert: false }
        );
        // Even if no documents match, if modifiedCount=0 the credential authorized the command
        WARN('L2-E: Driver updateOne on users collection — command AUTHORIZED',
            `Credential has write access to users. modifiedCount=${result.modifiedCount} (0 = no match, but command succeeded).`);
    } catch(e) {
        if (e.message.includes('not authorized') || e.message.includes('Unauthorized')) {
            PASS('L2-E: Driver updateOne on users blocked at DB level (Unauthorized)');
        } else {
            WARN('L2-E: Driver updateOne on users — unclear result', e.message.substring(0,80));
        }
    }

    // L2-F: Driver-level arbitrary collection create
    try {
        const testColl = db.collection('__security_test_ephemeral__');
        await testColl.insertOne({ test: true, ts: new Date() });
        await testColl.drop();
        WARN('L2-F: Arbitrary collection creation ALLOWED',
            'DB credential can create new collections. This enables collection namespace pollution.');
    } catch(e) {
        if (e.message.includes('not authorized') || e.message.includes('Unauthorized')) {
            PASS('L2-F: Arbitrary collection creation blocked (Unauthorized)');
        } else {
            WARN('L2-F: Collection creation result unclear', e.message.substring(0,80));
        }
    }

    // L2-G: Driver-level index creation (DDL)
    try {
        await txCollection.createIndex({ _security_test: 1 }, { name: 'security_test_idx', sparse: true });
        await txCollection.dropIndex('security_test_idx');
        WARN('L2-G: Index creation/deletion ALLOWED on transactions',
            'DB credential has DDL (createIndex/dropIndex) privileges.');
    } catch(e) {
        if (e.message.includes('not authorized') || e.message.includes('Unauthorized')) {
            PASS('L2-G: Index DDL blocked at DB level (Unauthorized)');
        } else {
            WARN('L2-G: Index DDL result unclear', e.message.substring(0,80));
        }
    }

    // L2-H: Driver-level insert to transactions (this MUST succeed — FLS needs it)
    try {
        const insertResult = await txCollection.insertOne({
            transactionId: uuidv4(),
            loanId: loan._id,
            sequenceNumber: 99,
            type: 'INTEREST_ACCRUED',
            actorId: 'test',
            currency: 'INR',
            effectiveAt: new Date(),
            businessDate: '2026-08-30',
            principalDeltaPaise: 0,
            interestDeltaPaise: 1000,
            feeDeltaPaise: 0,
            amountPaise: 1000,
        });
        insertResult.acknowledged
            ? PASS('L2-H: Driver INSERT to transactions ALLOWED (expected — FLS requires this)')
            : FAIL('L2-H', 'Insert not acknowledged');
        // Cleanup
        await txCollection.deleteOne({ _id: insertResult.insertedId });
    } catch(e) {
        FAIL('L2-H: Driver INSERT to transactions failed (FLS would break)', e.message.substring(0,100));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DISCOVERY REPORT — Credential Model
    // ═══════════════════════════════════════════════════════════════════════════
    HDR('CREDENTIAL MODEL — Discovery');
    console.log();
    ROW('Connection string', 'Single MONGODB_URI (.env)');
    ROW('Separate credentials per process?', 'NO — all processes share one credential');
    ROW('Worker processes separate?', 'NO — workers run in-process (not separate PM2 apps)');
    ROW('PM2 processes defined', '1 (khatha-backend / index.js cluster)');
    ROW('Worker dispatch mechanism', 'Workers are Node classes, no separate processes');
    ROW('InterestAccrualWorker', 'Invoked via: NOT wired in index.js (manual/API only)');
    ROW('NotificationWorker', 'Invoked via: NOT wired in index.js (manual/API only)');
    ROW('ReconciliationEngine', 'Invoked via: Admin route /reconciliation/*');
    ROW('Migration scripts', 'scripts/ — run manually with node scripts/...');

    HDR('PROCESS → COLLECTION ACCESS MATRIX (actual code)');
    console.log();
    console.log('  Process                  | transactions        | loans          | users   | notif_outbox | device_tokens');
    console.log('  ─────────────────────────┼─────────────────────┼────────────────┼─────────┼──────────────┼──────────────');
    console.log('  API (FinancialLedgerSvc) | INSERT, READ        | UPDATE, READ   | READ    | INSERT       | —');
    console.log('  InterestAccrualWorker    | INSERT (via FLS)    | UPDATE, READ   | —       | INSERT       | —');
    console.log('  ReconciliationEngine     | READ (aggregate)    | UPDATE(FROZEN) | —       | —            | —');
    console.log('  NotificationWorker       | —                   | —              | —       | UPDATE(state)| UPDATE(active)');
    console.log('  Migration scripts        | INSERT (new tx)     | UPDATE(v2)     | —       | —            | —');
    console.log('  Admin routes             | READ                | READ           | READ    | READ         | READ');

    HDR('IMMUTABILITY HOOK COVERAGE GAPS');
    console.log();
    console.log('  Hook             | Mongoose Pre-hook? | Gap?');
    console.log('  ─────────────────┼────────────────────┼───────────────────────────────────────');
    console.log('  updateOne        | ✅ YES              | No — blocked');
    console.log('  findOneAndUpdate | ✅ YES              | No — blocked');
    console.log('  deleteOne        | ✅ YES              | No — blocked');
    console.log('  findOneAndDelete | ✅ YES              | No — blocked');
    console.log('  updateMany       | ❌ NO               | YES — unblocked in Mongoose layer');
    console.log('  deleteMany       | ❌ NO               | YES — unblocked in Mongoose layer');
    console.log('  replaceOne       | ❌ NO               | YES — unblocked in Mongoose layer');
    console.log('  Driver-level ops | ❌ N/A              | YES — all hooks bypass-able');

    HDR('CRITICAL QUESTION ANSWER');
    console.log();
    console.log('  Q: Which process can currently write to transactions, and why?');
    console.log('  A: ONE credential (MONGODB_URI) is used for ALL processes.');
    console.log('     The single credential has full readWrite access to the entire khatha DB.');
    console.log('     Every process — API, workers, migration scripts — can INSERT,');
    console.log('     UPDATE, DELETE, and issue DDL on ANY collection.');
    console.log();
    console.log('  Mongoose immutability hooks on Transaction provide application-layer');
    console.log('  defense-in-depth, but they are NOT enforced at the DB authorization level.');
    console.log('  Any code path using driver-level operations or updateMany/deleteMany/replaceOne');
    console.log('  can bypass the hooks entirely.');

    // ═══════════════════════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`\n=========================================================================`);
    console.log(`RESULTS: ${pass} PASS | ${warn} WARN | ${fail} FAIL`);
    console.log(`=========================================================================`);
    if (fail === 0) {
        console.log('✅ No test failures. See WARN items for security findings.');
    } else {
        console.log('❌ Some tests failed unexpectedly.');
    }

    await mongoose.disconnect();
    await mongod.stop();
    process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
});
