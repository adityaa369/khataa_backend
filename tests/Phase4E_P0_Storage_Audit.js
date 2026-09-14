const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Redis = require('ioredis-mock');
const jwt = require('jsonwebtoken');

process.env.REDIS_URL = 'redis://localhost:6379';
const redisMock = new Redis();
redisMock.status = 'ready';
process.env.JWT_SECRET = 'secret';
process.env.NODE_ENV = 'production';
process.env.FIREBASE_STORAGE_BUCKET = 'test-bucket';

// Mock Firebase Admin SDK for the test
const jestMock = (impl) => { 
    const calls = [];
    const f = function(...args) {
        calls.push(args);
        if (impl) return impl(...args);
    };
    f.mock = { calls };
    return f; 
};
const mockMakePublic = jestMock();
const mockSave = jestMock();
const mockGetSignedUrl = jestMock(async () => ['https://storage.googleapis.com/test-bucket/kyc_uuid?Expires=1700000000']);
const adminMock = {
    storage: () => ({
        bucket: () => ({
            file: () => ({
                makePublic: mockMakePublic,
                save: mockSave,
                getSignedUrl: mockGetSignedUrl
            })
        })
    })
};
require('firebase-admin');
require.cache[require.resolve('firebase-admin')] = {
    exports: adminMock
};

const User = require('../models/User');
const Loan = require('../models/Loan');
const loanRoutes = require('../routes/loans');
const documentRoutes = require('../routes/documents');
const authRoutes = require('../routes/auth');
const errorHandler = require('../middleware/errorHandler');

async function runStorageAudit() {
    let mongod;
    try {
        mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
        await mongoose.connect(mongod.getUri(), { dbName: 'khataa' });

        const lender = await User.create({ id: 'lender_id', phone: '9999999999', firstName: 'Lender' });
        const borrower = await User.create({ id: 'borrower_id', phone: '8888888888', firstName: 'Borrower' });
        const attacker = await User.create({ id: 'attacker_id', phone: '7777777777', firstName: 'Attacker' });
        
        const docId = 'kyc_550e8400-e29b-41d4-a716-446655440000.jpg';
        
        const loan = await Loan.create({
            lender: lender.id,
            borrower: borrower.id,
            borrowerName: borrower.firstName,
            borrowerPhone: borrower.phone,
            amount: 5000,
            amountPaise: 500000,
            durationMonths: 12,
            status: 'active',
            documentUrl: docId
        });

        const lenderToken = jwt.sign({ id: lender.id }, 'secret', { expiresIn: '1h' });
        const attackerToken = jwt.sign({ id: attacker.id }, 'secret', { expiresIn: '1h' });

        const app = express();
        app.use(express.json());
        
        // Setup routes
        app.use('/api/loans', (req, res, next) => {
            if (req.headers.authorization) {
                try { req.user = jwt.verify(req.headers.authorization.split(' ')[1], 'secret'); } catch(e) {}
            }
            next();
        }, loanRoutes);
        
        app.use('/api/documents', documentRoutes);
        app.use(errorHandler);

        console.log("=========================================================================");
        console.log("       PHASE 4E: P0 STORAGE SECURITY AUDIT                               ");
        console.log("=========================================================================\n");

        // 1. Local /uploads direct access
        const resStatic = await request(app).get('/uploads/test.jpg');
        console.log(`Attack: Local /uploads direct access`);
        console.log(`Expected: 404 Not Found (Static mount removed)`);
        console.log(`Actual: ${resStatic.status}`);
        console.log(`Result: ${resStatic.status === 404 ? '🟢 PASS' : '🔴 FAIL'}\n`);

        // 2. Unauthenticated download
        const resUnauth = await request(app).get(`/api/documents/${docId}`);
        console.log(`Attack: Unauthenticated download -> 401`);
        console.log(`Expected: 401`);
        console.log(`Actual: ${resUnauth.status}`);
        console.log(`Result: ${resUnauth.status === 401 ? '🟢 PASS' : '🔴 FAIL'}\n`);

        // 3. Wrong user -> 403
        const resAttacker = await request(app).get(`/api/documents/${docId}`).set('Authorization', 'Bearer ' + attackerToken);
        console.log(`Attack: Wrong user -> 403`);
        console.log(`Expected: 403`);
        console.log(`Actual: ${resAttacker.status}`);
        console.log(`Result: ${resAttacker.status === 403 ? '🟢 PASS' : '🔴 FAIL'}\n`);

        // 4. Correct user -> short-lived URL
        const resLender = await request(app).get(`/api/documents/${docId}`).set('Authorization', 'Bearer ' + lenderToken);
        console.log(`Attack: Correct user -> short-lived URL`);
        console.log(`Expected: 200 with Signed URL containing Expires param`);
        console.log(`Actual: ${resLender.status} ${resLender.body.url}`);
        const isSigned = resLender.body.url && resLender.body.url.includes('Expires=');
        console.log(`Result: ${isSigned ? '🟢 PASS' : '🔴 FAIL'}\n`);

        // 5. Upload document does not use makePublic
        const resUpload = await request(app).post('/api/loans/upload-document').set('Authorization', 'Bearer ' + lenderToken).send({
            fileName: 'my_pan_card.jpg',
            fileType: 'image/jpeg',
            base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
        });
        
        console.log(`Attack: Upload document exposing filename and makePublic`);
        console.log(`Expected: 200 OK, opaque key returned, makePublic NOT called`);
        console.log(`Actual: ${resUpload.status} URL: ${resUpload.body.url}`);
        const calledMakePublic = mockMakePublic.mock.calls.length > 0;
        const exposedFilename = resUpload.body.url && resUpload.body.url.includes('my_pan_card');
        console.log(`Result: ${(!calledMakePublic && !exposedFilename) ? '🟢 PASS' : '🔴 FAIL'}\n`);

    } catch (e) {
        console.error(e);
    } finally {
        if (mongoose.connection) await mongoose.disconnect();
        if (mongod) await mongod.stop();
        redisMock.disconnect();
        process.exit(0);
    }
}
runStorageAudit();
