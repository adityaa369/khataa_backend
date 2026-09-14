require('dotenv').config();
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

async function testDocumentAuth() {
    console.log('\n--- RUNNING DOCUMENT UPLOAD/AUTH TESTS ---');
    
    
    // We will spin up the real express app
    const app = require('./index');

    const User = require('./models/User');
    await User.deleteMany({});
    
    const user = new User({ _id: new mongoose.Types.ObjectId(), phone: '9999999991', role: 'user', id: 'uploader1' });
    await user.save();

    const token = jwt.sign({ id: user.id, userId: user.id }, process.env.JWT_SECRET || 'secret');

    // 1. Unauthorized upload attempt
    let res = await request(app)
        .post('/api/loans/upload-document')
        .send({ fileName: 'test.pdf', fileType: 'application/pdf', base64Data: 'dGVzdA==' });
    if (res.status !== 401) throw new Error('Unauthorized upload did not return 401');
    console.log('✅ Unauthorized upload rejected (401)');

    // 2. Authorized upload attempt
    res = await request(app)
        .post('/api/loans/upload-document')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileName: 'test.pdf', fileType: 'application/pdf', base64Data: 'dGVzdA==' });
    if (res.status !== 200) throw new Error(`Authorized upload failed: ${res.status} ${JSON.stringify(res.body)}`);
    console.log('✅ Authorized upload succeeded');
    const documentId = res.body.documentId;
    if (!documentId) throw new Error('No documentId returned');

    // 3. Unauthorized document retrieval
    res = await request(app)
        .get(`/api/documents/${encodeURIComponent(documentId)}`);
    if (res.status !== 401) throw new Error('Unauthorized document access did not return 401');
    console.log('✅ Unauthorized document retrieval rejected (401)');

    // 4. Authorized document retrieval
    res = await request(app)
        .get(`/api/documents/${encodeURIComponent(documentId)}`)
        .set('Authorization', `Bearer ${token}`);
    if (res.status !== 200) throw new Error('Authorized document access failed');
    console.log('✅ Authorized document retrieval succeeded with Signed URL / Buffer');

    await mongoose.disconnect();
    console.log('--- DOCUMENT AUTH TESTS PASSED ---');
    process.exit(0);
}

testDocumentAuth().catch(err => {
    console.error(err);
    process.exit(1);
});
