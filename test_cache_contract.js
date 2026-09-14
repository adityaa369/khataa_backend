require('dotenv').config();
const request = require('supertest');
const app = require('./index');
const mongoose = require('mongoose');
const { getRedisClient, cacheGet } = require('./config/redis');
const User = require('./models/User');

async function run() {
    console.log('Running Cache Contract Test...');
    try {
        const user = await User.findOne({ phone: '9999999991' });
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
        
        const client = getRedisClient();
        if (client) await client.flushdb();

        // 1. Cache Miss
        let res = await request(app).get('/api/loans/given').set('Authorization', 'Bearer ' + token);
        if (res.status !== 200) throw new Error('GET /api/loans/given failed on miss: ' + res.status);
        
        let loans = res.body.loans;
        if (loans.length === 0) throw new Error('No loans found for test user');
        for (const loan of loans) {
            if (loan.amountPaise == null || !Number.isInteger(loan.amountPaise)) {
                throw new Error(`Cache miss response failed contract: amountPaise invalid on loan ${loan._id}`);
            }
        }
        console.log('✅ Cache miss returned canonical DTO.');

        // 2. Inspect Cache Contents directly
        const cacheKey = `loans:given:v2:${user._id}`;
        const cached = await cacheGet(cacheKey);
        if (!cached || !cached.loans) throw new Error('Cache was not populated');
        
        for (const loan of cached.loans) {
            if (loan.amountPaise == null || !Number.isInteger(loan.amountPaise)) {
                throw new Error(`Cache storage failed contract: amountPaise invalid on cached loan ${loan._id}`);
            }
        }
        console.log('✅ Cache storage holds canonical DTO.');

        // 3. Cache Hit
        res = await request(app).get('/api/loans/given').set('Authorization', 'Bearer ' + token);
        if (res.status !== 200) throw new Error('GET /api/loans/given failed on hit: ' + res.status);
        
        loans = res.body.loans;
        for (const loan of loans) {
            if (loan.amountPaise == null || !Number.isInteger(loan.amountPaise)) {
                throw new Error(`Cache hit response failed contract: amountPaise invalid on loan ${loan._id}`);
            }
        }
        console.log('✅ Cache hit returned canonical DTO.');
        
        console.log('All Cache Contract tests passed!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Cache Contract Test failed:', err.message);
        process.exit(1);
    }
}
run();
