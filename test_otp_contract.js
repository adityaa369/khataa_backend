require('dotenv').config();
const request = require('supertest');
const app = require('./index');

async function run() {
    console.log('Running OTP Contract Test...');
    try {
        // We will send an invalid OTP token to verify it doesn't crash with undefined property length
        const res = await request(app)
            .post('/api/auth/verify-otp')
            .send({ idToken: 'invalid_token_to_test_crash' });
            
        if (res.status === 500) {
            throw new Error(`OTP endpoint crashed with 500: ${JSON.stringify(res.body)}`);
        }
        
        if (res.status !== 401 && res.status !== 400 && res.status !== 200) {
            throw new Error(`Unexpected status code: ${res.status}`);
        }
        
        if (res.body.success === true) {
            throw new Error('Invalid token should not succeed');
        }
        
        console.log('✅ OTP endpoint handles invalid tokens safely without crashing.');
        process.exit(0);
    } catch (err) {
        console.error('❌ OTP Contract Test failed:', err.message);
        process.exit(1);
    }
}
run();
