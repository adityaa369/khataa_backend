const assert = require('assert');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { uploadDocument } = require('../controllers/loans');
const { downloadDocument } = require('../controllers/documents');
const GridFSService = require('../services/GridFSService');
const Loan = require('../models/Loan');
const User = require('../models/User');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Mock Auth
let currentUser = { id: 'user1' };
const protect = (req, res, next) => {
    if (!currentUser) return res.status(401).json({ success: false, message: 'Unauthorized' });
    req.user = currentUser;
    next();
};

app.post('/api/loans/upload-document', protect, uploadDocument);
app.get('/api/documents/:id/download', protect, downloadDocument);

async function runTests() {
    console.log('Running P0-7 GridFS Documents Tests...');
    let testsExecuted = 0;
    let pass = 0;
    let fail = 0;
    let assertions = 0;

    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/khaata_test_p07', {
        useNewUrlParser: true,
        useUnifiedTopology: true
    });

    const assertEq = (actual, expected, msg) => {
        assertions++;
        try {
            assert.strictEqual(actual, expected, msg);
        } catch (e) {
            console.error(`FAIL: ${e.message}`);
            throw e;
        }
    };

    const runTest = async (name, testFn) => {
        testsExecuted++;
        try {
            await testFn();
            console.log(`[TEST] ${name} - ✅ Pass`);
            pass++;
        } catch (e) {
            console.error(`[TEST] ${name} - ❌ Fail`);
            console.error(e);
            fail++;
        }
    };

    let savedDocumentId = '';
    const sampleText = 'Hello GridFS Security!';
    const base64Data = Buffer.from(sampleText).toString('base64');

    await runTest('Upload authenticated user returns documentId', async () => {
        currentUser = { id: 'uploader_123' };
        const res = await request(app)
            .post('/api/loans/upload-document')
            .send({
                fileName: 'test.pdf',
                fileType: 'application/pdf',
                base64Data: base64Data
            });
        assertions++;
        assert.strictEqual(res.status, 200);
        assertions++;
        assert.ok(res.body.documentId);
        savedDocumentId = res.body.documentId;
    });

    await runTest('Verify actual GridFS persistence', async () => {
        const metadata = await GridFSService.getDocumentMetadata(savedDocumentId);
        assertions++;
        assert.ok(metadata);
        assertions++;
        assert.strictEqual(metadata.metadata.uploadedBy, 'uploader_123');
    });

    await runTest('Download authorized document exact byte round-trip', async () => {
        currentUser = { id: 'uploader_123' };
        const res = await request(app)
            .get(`/api/documents/${savedDocumentId}/download`)
            .responseType('blob');
        assertions++;
        assert.strictEqual(res.status, 200);
        assertions++;
        assert.strictEqual(res.body.toString(), sampleText);
    });

    await runTest('Unauthorized user rejected', async () => {
        currentUser = { id: 'attacker_999' };
        const res = await request(app)
            .get(`/api/documents/${savedDocumentId}/download`);
        assertions++;
        assert.strictEqual(res.status, 403);
    });

    await runTest('Authorized via Loan Association', async () => {
        await Loan.create({
            _id: new mongoose.Types.ObjectId(),
            lender: 'attacker_999',
            borrower: 'someone',
            borrowerName: 'Someone',
            amount: 100,
            amountPaise: 10000,
            interestRate: 1,
            documentId: savedDocumentId,
            durationMonths: 1,
            borrowerPhone: '123'
        });

        currentUser = { id: 'attacker_999' }; 
        const res = await request(app)
            .get(`/api/documents/${savedDocumentId}/download`)
            .responseType('blob');
        assertions++;
        assert.strictEqual(res.status, 200);
        assertions++;
        assert.strictEqual(res.body.toString(), sampleText);
    });

    await runTest('Nonexistent document rejected', async () => {
        currentUser = { id: 'uploader_123' };
        const res = await request(app)
            .get(`/api/documents/648a12345678901234567890/download`);
        assertions++;
        assert.strictEqual(res.status, 404);
    });

    await runTest('File-type limits enforced', async () => {
        currentUser = { id: 'uploader_123' };
        const res = await request(app)
            .post('/api/loans/upload-document')
            .send({
                fileName: 'test.exe',
                fileType: 'application/x-msdownload',
                base64Data: base64Data
            });
        assertions++;
        assert.strictEqual(res.status, 400);
        assertions++;
        assert.ok(res.body.message.includes('Allowed'));
    });

    await runTest('File-size limits enforced', async () => {
        currentUser = { id: 'uploader_123' };
        const hugeBuffer = Buffer.alloc(6 * 1024 * 1024, 'a');
        const hugeBase64 = hugeBuffer.toString('base64');
        const res = await request(app)
            .post('/api/loans/upload-document')
            .send({
                fileName: 'test2.pdf',
                fileType: 'application/pdf',
                base64Data: hugeBase64
            });
        assertions++;
        assert.strictEqual(res.status, 400);
        assertions++;
        assert.ok(res.body.message.includes('too large'));
    });

    console.log(`\nResults: TESTS_EXECUTED: ${testsExecuted} / PASS: ${pass} / FAIL: ${fail} / SKIP: 0 / ERROR: 0 / TOTAL_ASSERTIONS: ${assertions}`);
    await mongoose.connection.close();
}

runTests().catch(console.error);
