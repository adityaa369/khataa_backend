/**
 * Phase 4E — All-Role Capability Test
 * Tests EVERY restricted operation against EVERY role in the Staging DB.
 */
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function PASS(t) { console.log(`🟢 PASS   ${t}`); pass++; }
function FAIL(t, d) { console.log(`🔴 FAIL   ${t} — ${d}`); fail++; }

async function testOp(client, dbName, collection, op, expectSuccess) {
    const db = client.db(dbName);
    const coll = db.collection(collection);
    let result = null;
    let error = null;

    try {
        if (op === 'FIND') await coll.findOne({});
        else if (op === 'INSERT') await coll.insertOne({ _id: `test_${Date.now()}_${Math.random()}` });
        else if (op === 'UPDATE') await coll.updateOne({}, { $set: { val: 1 } });
        else if (op === 'DELETE') await coll.deleteOne({});
        else if (op === 'DROP') await coll.drop();
        else if (op === 'CREATE_COLLECTION') await db.createCollection(`new_coll_${Date.now()}`);
        else if (op === 'CREATE_INDEX') await coll.createIndex({ testIdx: 1 });
        result = 'Success';
    } catch (e) {
        error = e;
    }

    const wasSuccess = !error && result === 'Success';
    const isAuthError = error && (error.message.includes('not authorized') || error.message.includes('Unauthorized') || error.code === 13);

    if (expectSuccess && wasSuccess) return true;
    if (!expectSuccess && isAuthError) return true;
    
    console.log(`     FAILED: Expected ${expectSuccess ? 'Success' : 'Auth Error'}, got ${wasSuccess ? 'Success' : (error ? error.message : 'Unknown')}`);
    return false;
}

async function run() {
    console.log('=========================================================================');
    console.log('  ALL-ROLE CAPABILITY TEST (Staging DB Simulation)');
    console.log('=========================================================================\n');
    
    const uris = JSON.parse(fs.readFileSync(path.join(__dirname, 'staging_uris.json'), 'utf8'));

    // Matrix defining what SHOULD be allowed
    const matrix = {
        api: { // app_financial_writer
            transactions: { FIND: true, INSERT: true, UPDATE: false, DELETE: false, DROP: false, CREATE_INDEX: false },
            loans: { FIND: true, INSERT: true, UPDATE: true, DELETE: false },
            system: { CREATE_COLLECTION: false }
        },
        notif: { // app_notification_worker
            transactions: { FIND: true, INSERT: false, UPDATE: false, DELETE: false },
            notification_outbox: { FIND: true, INSERT: false, UPDATE: true, DELETE: false }
        },
        recon: { // app_reconciliation
            transactions: { FIND: true, INSERT: false, UPDATE: false, DELETE: false },
            loans: { FIND: true, INSERT: false, UPDATE: true, DELETE: false }
        },
        migration: { // app_migration
            transactions: { FIND: true, INSERT: true, UPDATE: false, DELETE: false },
            loans: { FIND: true, INSERT: false, UPDATE: true, DELETE: false }
        },
        readonly: { // app_readonly_admin
            transactions: { FIND: true, INSERT: false, UPDATE: false, DELETE: false },
            loans: { FIND: true, INSERT: false, UPDATE: false, DELETE: false }
        }
    };

    const targetDb = 'khatha';

    // Seed data with root
    const rootClient = await MongoClient.connect(uris.root);
    await rootClient.db(targetDb).collection('transactions').insertOne({ _id: 'seed' });
    await rootClient.db(targetDb).collection('loans').insertOne({ _id: 'seed' });
    await rootClient.db(targetDb).collection('notification_outbox').insertOne({ _id: 'seed' });
    
    for (const [roleKey, roleMatrix] of Object.entries(matrix)) {
        console.log(`\n── Testing Role: ${roleKey.toUpperCase()}`);
        const client = await MongoClient.connect(uris[roleKey]);
        
        let rolePass = true;
        for (const [collName, ops] of Object.entries(roleMatrix)) {
            for (const [opName, expectSuccess] of Object.entries(ops)) {
                const ok = await testOp(client, targetDb, collName, opName, expectSuccess);
                if (!ok) {
                    FAIL(`[${roleKey}] ${collName} ${opName}`, `Expected ${expectSuccess ? 'Allowed' : 'Blocked'}`);
                    rolePass = false;
                }
            }
        }
        
        if (rolePass) {
            PASS(`All capability tests passed for ${roleKey}`);
        }
        await client.close();
    }

    await rootClient.close();

    console.log(`\n=========================================================================`);
    console.log(`RESULTS: ${pass} roles passed / ${fail} roles failed`);
    console.log(`=========================================================================`);
    process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
