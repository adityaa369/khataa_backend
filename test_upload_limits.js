require('dotenv').config();
const request = require('supertest');
const app = require('./index');

async function testUploadLimits() {
    // 150kb base64 payload (larger than 100kb limit)
    const largePayload = 'A'.repeat(150 * 1024);
    
    console.log('Sending 150kb payload...');
    const res = await request(app)
        .post('/api/loans/upload-document')
        .send({
            fileName: 'test.pdf',
            fileType: 'application/pdf',
            base64Data: largePayload
        });
        
    console.log('Status:', res.status);
    console.log('Body:', res.body);
    console.log('Text:', res.text);
    process.exit(0);
}

testUploadLimits();
