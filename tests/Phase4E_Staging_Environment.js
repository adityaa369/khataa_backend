/**
 * Phase 4E — Staging Environment Simulator
 * Spins up a persistent MongoMemoryServer with Auth enabled to act as 
 * the Atlas Staging Cluster. Provisions all roles and users.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

async function setupStaging() {
    console.log('[Staging] Starting isolated MongoDB cluster with Auth enabled...');
    const mongod = await MongoMemoryServer.create({
        instance: { port: 27018 },
        auth: { enable: true, customRootName: 'admin', customRootPwd: 'admin_password' }
    });

    const rootUri = mongod.getUri();
    console.log(`[Staging] Cluster running at: ${rootUri}`);
    const hostPort = rootUri.split('mongodb://')[1].split('/')[0];
    
    const client = new MongoClient(rootUri, { auth: { username: 'admin', password: 'admin_password' } });
    await client.connect();
    
    const db = client.db('admin');
    const targetDb = 'khatha';

    console.log('[Staging] Provisioning custom Atlas roles...');

    // 1. app_financial_writer
    await db.command({
        createRole: 'app_financial_writer',
        privileges: [
            { resource: { db: targetDb, collection: 'transactions' }, actions: ['find', 'insert'] },
            { resource: { db: targetDb, collection: 'loans' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDb, collection: 'users' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDb, collection: 'transactionintents' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDb, collection: 'notificationoutboxes' }, actions: ['find', 'insert'] },
            { resource: { db: targetDb, collection: 'devicetokens' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDb, collection: 'otpchallenges' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDb, collection: 'documents' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDb, collection: 'financialkillswitches' }, actions: ['find'] },
            { resource: { db: targetDb, collection: 'idempotencykeys' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDb, collection: 'chitsubscriptions' }, actions: ['find'] },
            { resource: { db: targetDb, collection: 'creditscores' }, actions: ['find', 'insert', 'update'] },
            { resource: { db: targetDb, collection: 'notifications' }, actions: ['find', 'insert', 'update'] }
        ],
        roles: []
    });
    await db.command({ createUser: 'api_user', pwd: 'api_password', roles: [{ role: 'app_financial_writer', db: 'admin' }] });

    // 2. app_notification_worker
    await db.command({
        createRole: 'app_notification_worker',
        privileges: [
            { resource: { db: targetDb, collection: 'transactions' }, actions: ['find'] },
            { resource: { db: targetDb, collection: 'loans' }, actions: ['find'] },
            { resource: { db: targetDb, collection: 'users' }, actions: ['find'] },
            { resource: { db: targetDb, collection: 'notificationoutboxes' }, actions: ['find', 'update', 'remove'] },
            { resource: { db: targetDb, collection: 'devicetokens' }, actions: ['find', 'update'] }
        ],
        roles: []
    });
    await db.command({ createUser: 'notif_user', pwd: 'notif_password', roles: [{ role: 'app_notification_worker', db: 'admin' }] });

    // 3. app_reconciliation
    await db.command({
        createRole: 'app_reconciliation',
        privileges: [
            { resource: { db: targetDb, collection: 'transactions' }, actions: ['find'] },
            { resource: { db: targetDb, collection: 'loans' }, actions: ['find', 'update'] },
            { resource: { db: targetDb, collection: '' }, actions: ['find'] } // Any other collection read-only
        ],
        roles: []
    });
    await db.command({ createUser: 'recon_user', pwd: 'recon_password', roles: [{ role: 'app_reconciliation', db: 'admin' }] });

    // 4. app_migration
    await db.command({
        createRole: 'app_migration',
        privileges: [
            { resource: { db: targetDb, collection: 'transactions' }, actions: ['find', 'insert'] },
            { resource: { db: targetDb, collection: 'loans' }, actions: ['find', 'update'] }
        ],
        roles: []
    });
    await db.command({ createUser: 'migration_user', pwd: 'migration_password', roles: [{ role: 'app_migration', db: 'admin' }] });

    // 5. app_readonly_admin
    await db.command({
        createRole: 'app_readonly_admin',
        privileges: [
            { resource: { db: targetDb, collection: '' }, actions: ['find'] }
        ],
        roles: []
    });
    await db.command({ createUser: 'readonly_user', pwd: 'readonly_password', roles: [{ role: 'app_readonly_admin', db: 'admin' }] });

    console.log('[Staging] Roles and Users provisioned successfully.');

    // Extract host and port from rootUri
    const baseUri = `mongodb://${hostPort}/${targetDb}?authSource=admin`;

    const uris = {
        root: rootUri,
        api: `mongodb://api_user:api_password@${hostPort}/${targetDb}?authSource=admin`,
        notif: `mongodb://notif_user:notif_password@${hostPort}/${targetDb}?authSource=admin`,
        recon: `mongodb://recon_user:recon_password@${hostPort}/${targetDb}?authSource=admin`,
        migration: `mongodb://migration_user:migration_password@${hostPort}/${targetDb}?authSource=admin`,
        readonly: `mongodb://readonly_user:readonly_password@${hostPort}/${targetDb}?authSource=admin`,
    };

    fs.writeFileSync(path.join(__dirname, 'staging_uris.json'), JSON.stringify(uris, null, 2));
    console.log('[Staging] URIs written to tests/staging_uris.json');
    console.log('[Staging] Keeping process alive. Press Ctrl+C to terminate the Staging Cluster.');

    // Keep alive
    setInterval(() => {}, 1000 * 60 * 60);
}

setupStaging().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
