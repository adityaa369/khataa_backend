process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
process.env.REDIS_URL = 'redis://localhost';
process.env.JWT_SECRET = 'test_secret';
process.env.PORT = 5001;
require.cache[require.resolve('ioredis')] = { exports: require('ioredis-mock') };
const mongoose = require('mongoose');

async function setup() {
    const { MongoMemoryServer } = require('mongodb-memory-server-core');
    const mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    
    const request = require('supertest');
    const server = require('../index');
    const User = require('../models/User');

    function PASS(t) { console.log(`\x1b[32mPASS\x1b[0m   ${t}`); }
    function FAIL(t, d) { console.log(`\x1b[31mFAIL\x1b[0m   ${t} - ${d}`); }
    function HDR(t) { console.log(`\n\x1b[36m=== ${t} ===\x1b[0m`); }

    return { request, server, User, PASS, FAIL, HDR };
}

setup().then(({ request, server, User, PASS, FAIL, HDR }) => {
    async function runDiscovery() {
        HDR('P2 FCM Token Ownership - Discovery Report');

        // 1. Check Data Model
        HDR('1. Token Data Model Analysis');
    const userSchemaPaths = User.schema.paths;
    if (userSchemaPaths.fcmToken) {
        if (!userSchemaPaths.fcmToken.options.unique) {
            FAIL('User.fcmToken Uniqueness', 'fcmToken is NOT unique. Multiple users can share the same token.');
        } else {
            PASS('User.fcmToken Uniqueness');
        }
    }

    try {
        const DeviceToken = require('../models/DeviceToken');
        if (DeviceToken) PASS('DeviceToken model exists');
    } catch (e) {
        FAIL('DeviceToken model', 'Does not exist');
    }

    // Connect DB
    await mongoose.connect(process.env.MONGODB_URI);
    await User.deleteMany({});

    // 2. Token Ownership Attack (Cross-user registration)
    HDR('2. Token Ownership Attack');
    const uA = await User.create({ id: 'UA', phone: '1111111111', firebaseUid: 'UA' });
    const uB = await User.create({ id: 'UB', phone: '2222222222', firebaseUid: 'UB' });

    const tokenA = require('jsonwebtoken').sign({ id: uA.id }, 'test_secret');
    const tokenB = require('jsonwebtoken').sign({ id: uB.id }, 'test_secret');

    // User A registers Token X
    await request('http://localhost:5001').post('/api/users/fcm-token').set('Authorization', `Bearer ${tokenA}`).send({ fcmToken: 'TOKEN_X' });
    let dbA = await User.findOne({ id: 'UA' });
    if (dbA.fcmToken === 'TOKEN_X') PASS('User A registered Token X');

    // User B registers Token X (same device)
    await request('http://localhost:5001').post('/api/users/fcm-token').set('Authorization', `Bearer ${tokenB}`).send({ fcmToken: 'TOKEN_X' });
    
    dbA = await User.findOne({ id: 'UA' });
    let dbB = await User.findOne({ id: 'UB' });

    if (dbB.fcmToken === 'TOKEN_X' && dbA.fcmToken === 'TOKEN_X') {
        FAIL('Token Reassignment', 'Backend allowed both User A and User B to hold TOKEN_X simultaneously (Stale Binding Leakage)');
    } else if (dbB.fcmToken === 'TOKEN_X' && dbA.fcmToken !== 'TOKEN_X') {
        PASS('Token Reassignment handles unbinding automatically');
    }

    // 3. Logout Behavior
    HDR('3. Logout Behavior');
    // Backend has no logout endpoint for JWT. Let's see if there's any token unbind endpoint.
    const delRes = await request('http://localhost:5001').delete('/api/users/fcm-token').set('Authorization', `Bearer ${tokenA}`);
    const logoutRes = await request('http://localhost:5001').post('/api/users/logout').set('Authorization', `Bearer ${tokenA}`);
    
    let unbindExists = (delRes.status !== 404 && logoutRes.status !== 404);

    if (!unbindExists) {
        FAIL('Logout Unbinding', 'No backend endpoint exists to clear FCM token on logout');
    }

    // 4. Notification Routing Check
    HDR('4. Notification Routing Check');
    const fs = require('fs');
    const loansJs = fs.readFileSync('controllers/loans.js', 'utf8');
    
        if (loansJs.includes('borrowerUser.fcmToken')) {
            FAIL('Notification Recipient', 'Loans controller reads fcmToken directly from User model, bypassing DeviceToken registry');
        } else {
            PASS('Notification Recipient uses DeviceToken registry');
        }

        console.log('\n\x1b[33mDiscovery Complete.\x1b[0m');
        process.exit(0);
    }
    
    runDiscovery().catch(console.error);
});
