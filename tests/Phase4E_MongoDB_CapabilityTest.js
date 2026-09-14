/**
 * Phase 4E Suite 12 — MongoDB Least Privilege Capability Testing
 * ===============================================================
 * This script spins up a MongoDB instance WITH AUTHENTICATION enabled
 * to simulate the exact Atlas Custom Roles environment.
 * 
 * It provisions the roles, creates users, and tests the DB-level 
 * authorization boundaries (rejecting UPDATE/DELETE on transactions).
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

let pass = 0, fail = 0;
function PASS(t) { console.log(`🟢 PASS   ${t}`); pass++; }
function FAIL(t, d) { console.log(`🔴 FAIL   ${t} — ${d}`); fail++; }
function HDR(t) { console.log(`\n── ${t}`); }

async function testOperation(client, dbName, collection, operation, label, expectSuccess) {
    const db = client.db(dbName);
    const coll = db.collection(collection);
    
    let result = null;
    let error = null;

    try {
        switch (operation) {
            case 'FIND':
                await coll.findOne({});
                result = 'Success';
                break;
            case 'INSERT':
                const r = await coll.insertOne({ _id: `test_${Date.now()}_${Math.random()}`, test: true });
                result = r.acknowledged ? 'Success' : null;
                break;
            case 'UPDATE':
                await coll.updateOne({}, { $set: { testUpdate: true } });
                result = 'Success';
                break;
            case 'DELETE':
                await coll.deleteOne({});
                result = 'Success';
                break;
            case 'DROP':
                await coll.drop();
                result = 'Success';
                break;
            case 'CREATE_COLLECTION':
                await db.createCollection(`new_coll_${Date.now()}`);
                result = 'Success';
                break;
            case 'CREATE_INDEX':
                await coll.createIndex({ test: 1 });
                result = 'Success';
                break;
        }
    } catch (e) {
        error = e;
    }

    const wasSuccess = !error && result === 'Success';
    
    if (expectSuccess && wasSuccess) {
        PASS(`${label} Allowed (Expected)`);
    } else if (!expectSuccess && !wasSuccess && (error.message.includes('not authorized') || error.message.includes('Unauthorized') || error.code === 13)) {
        PASS(`${label} Blocked (Expected) - Unauthorized`);
    } else if (expectSuccess && !wasSuccess) {
        FAIL(`${label} Expected Allowed, but was Blocked`, error ? error.message : 'Unknown');
    } else if (!expectSuccess && wasSuccess) {
        FAIL(`${label} Expected Blocked, but was Allowed`, 'Critical Security Gap');
    } else {
        FAIL(`${label} Unexpected outcome`, error ? error.message : 'Unknown');
    }
}

async function run() {
    console.log('Starting MongoDB Memory Server with Authentication...');
    
    const mongod = await MongoMemoryServer.create({
        auth: {
            enable: true,
            customRootName: 'admin',
            customRootPwd: 'admin_password'
        }
    });
    
    const uri = mongod.getUri();
    
    // Connect as ROOT to provision roles and users
    const rootClient = await MongoClient.connect(uri, { auth: { username: 'admin', password: 'admin_password' } });
    const adminDb = rootClient.db('admin');
    const targetDbName = 'khatha';
    
    HDR('PROVISIONING ROLES (Simulating Atlas Configuration)');
    
    // Role 1: app_financial_writer
    await adminDb.command({
        createRole: 'app_financial_writer',
        privileges: [
            { resource: { db: targetDbName, collection: 'transactions' }, actions: ['find', 'insert'] }, // NO update/remove
            { resource: { db: targetDbName, collection: 'loans' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDbName, collection: 'users' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDbName, collection: 'transaction_intents' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDbName, collection: 'notification_outbox' }, actions: ['find', 'insert'] },
            { resource: { db: targetDbName, collection: 'device_tokens' }, actions: ['find', 'insert', 'update'] }
        ],
        roles: []
    });
    console.log('Created role: app_financial_writer');
    
    // Create User for app_financial_writer
    await adminDb.command({
        createUser: 'writer_user',
        pwd: 'writer_password',
        roles: [{ role: 'app_financial_writer', db: 'admin' }]
    });

    // Seed some initial collections & data as root so find/update have targets
    const seedDb = rootClient.db(targetDbName);
    await seedDb.collection('transactions').insertOne({ _id: 'tx_seed', amountPaise: 100 });
    await seedDb.collection('loans').insertOne({ _id: 'loan_seed', principal: 100 });

    HDR('CAPABILITY TESTING: app_financial_writer');
    
    // Connect as writer_user
    const writerUri = uri; // Same URI, different auth
    const writerClient = await MongoClient.connect(writerUri, { auth: { username: 'writer_user', password: 'writer_password' } });

    // Test specific boundaries
    await testOperation(writerClient, targetDbName, 'transactions', 'INSERT', 'Transaction INSERT', true);
    await testOperation(writerClient, targetDbName, 'transactions', 'FIND', 'Transaction FIND', true);
    
    // CRITICAL SECURITY TESTS: Ensure UPDATE/DELETE fail at the driver level
    await testOperation(writerClient, targetDbName, 'transactions', 'UPDATE', 'Transaction UPDATE', false);
    await testOperation(writerClient, targetDbName, 'transactions', 'DELETE', 'Transaction DELETE', false);
    
    // Ensure DDL fails
    await testOperation(writerClient, targetDbName, 'transactions', 'DROP', 'Transaction DROP', false);
    await testOperation(writerClient, targetDbName, 'transactions', 'CREATE_INDEX', 'Transaction CREATE_INDEX', false);
    await testOperation(writerClient, targetDbName, 'system', 'CREATE_COLLECTION', 'Arbitrary CREATE_COLLECTION', false);

    // Other collections should work normally
    await testOperation(writerClient, targetDbName, 'loans', 'UPDATE', 'Loan UPDATE', true);
    await testOperation(writerClient, targetDbName, 'notification_outbox', 'INSERT', 'Outbox INSERT', true);
    // But no delete on loans either
    await testOperation(writerClient, targetDbName, 'loans', 'DELETE', 'Loan DELETE', false);

    HDR('SUMMARY');
    console.log(`\n=========================================================================`);
    console.log(`RESULTS: ${pass} passed / ${fail} failed`);
    console.log(`=========================================================================`);
    
    if (fail === 0) {
        console.log('✅ All Database Authorization Capabilities verified. Least Privilege Enforced.');
    } else {
        console.log('❌ Role configuration gap exists.');
    }

    await writerClient.close();
    await rootClient.close();
    await mongod.stop();
    process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
