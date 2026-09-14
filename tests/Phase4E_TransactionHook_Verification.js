/**
 * Transaction Immutability Hook Verification
 * Loads the REAL models/Transaction.js and verifies all 7 hooks block correctly.
 */
process.env.JWT_SECRET = 'test_secret';
process.env.NODE_ENV = 'test';

const path = require('path');

// Mock firebase-admin and redis (required by some transitive imports)
const adminMock = { apps: [true], auth: () => ({ verifyIdToken: async () => ({ uid: 'x', phone_number: '+919999999999' }) }) };
require.cache[require.resolve('firebase-admin')] = { exports: adminMock };
require.cache[require.resolve(path.join(__dirname, '..', 'config', 'firebase'))] = { exports: adminMock };
const RedisMock = require('ioredis-mock');
const redisMock = new RedisMock(); redisMock.status = 'ready';
require.cache[require.resolve(path.join(__dirname, '..', 'config', 'redis'))] = {
    exports: { getRedisClient: () => redisMock, isRedisAvailable: () => true, cacheGet: async () => null, cacheSet: async () => {}, cacheInvalidate: async () => {}, cacheInvalidatePattern: async () => {}, connectRedisStrict: async () => {} }
};

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

let pass = 0, fail = 0;
function PASS(t) { console.log(`🟢 PASS  ${t}`); pass++; }
function FAIL(t, d) { console.log(`🔴 FAIL  ${t} — ${d}`); fail++; }

async function mustThrowImmutability(label, fn) {
    try {
        await fn();
        FAIL(label, 'Did NOT throw — operation was permitted!');
    } catch (e) {
        if (e.message && e.message.includes('IMMUTABILITY_VIOLATION')) {
            PASS(label);
        } else {
            FAIL(label, `Wrong error: ${e.message.substring(0, 80)}`);
        }
    }
}

async function run() {
    const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri(), { dbName: 'hook_test' });

    // Load the ACTUAL production Transaction model
    const Transaction = require('../models/Transaction');

    const loanId = new mongoose.Types.ObjectId();

    const tx = await new Transaction({
        loanId, sequenceNumber: 1, type: 'LOAN_CREATED',
        actorId: 'test', effectiveAt: new Date(), businessDate: '2026-08-30',
        principalDeltaPaise: 100000, interestDeltaPaise: 0, feeDeltaPaise: 0, amountPaise: 100000
    }).save();

    console.log('=========================================================================');
    console.log('  Transaction Immutability Hook Verification (models/Transaction.js)');
    console.log('=========================================================================\n');

    // All 7 hooks must block
    await mustThrowImmutability('updateOne blocked',        () => Transaction.updateOne({ _id: tx._id }, { $set: { amountPaise: 0 } }));
    await mustThrowImmutability('findOneAndUpdate blocked', () => Transaction.findOneAndUpdate({ _id: tx._id }, { $set: { amountPaise: 0 } }));
    await mustThrowImmutability('updateMany blocked',       () => Transaction.updateMany({ loanId }, { $set: { amountPaise: 0 } }));
    await mustThrowImmutability('replaceOne blocked',       () => Transaction.replaceOne({ _id: tx._id }, { amountPaise: 0 }));
    await mustThrowImmutability('deleteOne blocked',        () => Transaction.deleteOne({ _id: tx._id }));
    await mustThrowImmutability('findOneAndDelete blocked', () => Transaction.findOneAndDelete({ _id: tx._id }));
    await mustThrowImmutability('deleteMany blocked',       () => Transaction.deleteMany({ loanId }));

    // INSERT must still work
    try {
        const newTx = await new Transaction({
            loanId, sequenceNumber: 2, type: 'INTEREST_ACCRUED',
            actorId: 'fls', effectiveAt: new Date(), businessDate: '2026-08-30',
            principalDeltaPaise: 0, interestDeltaPaise: 1000, feeDeltaPaise: 0, amountPaise: 1000
        }).save();
        newTx._id ? PASS('INSERT (new Transaction) still allowed') : FAIL('INSERT', 'No _id returned');
    } catch (e) {
        FAIL('INSERT must still work', e.message.substring(0, 80));
    }

    console.log(`\n=========================================================================`);
    console.log(`RESULTS: ${pass} passed / ${fail} failed`);
    console.log(`=========================================================================`);
    if (fail === 0) {
        console.log('✅ All 7 immutability hooks enforced. INSERT still works.');
    } else {
        console.log('❌ Hook gaps remain.');
    }

    await mongoose.disconnect();
    await mongod.stop();
    redisMock.disconnect();
    process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
