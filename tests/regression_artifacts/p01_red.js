const request = require('supertest');
const app = require('../../index'); 

async function runRedTest() {
  console.log('--- Running P0-1 RED Reproduction ---');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  const payload = {
    idToken: 'mockToken',
    phone: '9999999999'
  };

  try {
    const res = await request('http://localhost:5000').post('/api/auth/verify-otp').send(payload);
    console.log('Response:', res.body);
  } catch (err) {
    console.log('Error stack:', err.stack);
  }

  process.exit(0);
}

runRedTest().catch(e => { console.error(e); process.exit(1); });
