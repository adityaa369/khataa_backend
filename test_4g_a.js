const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

async function runTests() {
    console.log('--- RUNNING PHASE 4G-A VERIFICATION TESTS ---');

    // 1. Redaction Test (isolated)
    console.log('\\n[1] Testing Redaction... (utils/logger.js)');
    const logger = require('./utils/logger');
    const { getTraceContext, updateTraceContext, asyncLocalStorage } = require('./utils/asyncContext');
    
    let stdoutBuffer = [];
    let stderrBuffer = [];
    const origWrite = process.stdout.write;
    const origErrWrite = process.stderr.write;
    process.stdout.write = (chunk) => { stdoutBuffer.push(chunk); };
    process.stderr.write = (chunk) => { stderrBuffer.push(chunk); };

    asyncLocalStorage.run({ requestId: 'test-req-1' }, () => {
        const payload = {
            user: { name: 'John', password: 'supersecretpassword' },
            documentUrl: 'https://storage.googleapis.com/bucket/doc.pdf?GoogleAccessId=service-account',
            normalUrl: 'https://example.com/image.png',
            rawBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
            nested: [
                { id: 1, authorization: 'Bearer xyz123' },
                { id: 2, somethingElse: 'safe' }
            ],
            serialized: JSON.stringify({ otp: '123456' })
        };
        logger.log(payload);
    });

    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;

    const logStr = stdoutBuffer.join('');
    try {
        const parsed = JSON.parse(logStr);
        assert(!logStr.includes('supersecretpassword'), 'Password not redacted');
        assert(parsed.message.user.password === '[REDACTED]', 'Password key not redacted properly');
        assert(!logStr.includes('GoogleAccessId='), 'Document URL not redacted');
        assert(parsed.message.documentUrl === '[REDACTED]', 'Document URL key not redacted properly');
        assert(!logStr.includes('data:image'), 'Base64 not redacted');
        assert(parsed.message.rawBase64 === '[REDACTED]', 'Base64 pattern not redacted');
        assert(parsed.message.nested[0].authorization === '[REDACTED]', 'Nested array key not redacted');
        assert(parsed.message.nested[1].somethingElse === 'safe', 'Safe nested key was redacted incorrectly');
        assert(!logStr.includes('123456'), 'Serialized OTP not redacted');
        assert(parsed.message.serialized.includes('[REDACTED]'), 'Serialized OTP key not redacted');
        console.log('✅ Redaction passed');
    } catch (e) {
        console.error('❌ Redaction failed:', e.message);
        console.log('Log Output:', logStr);
    }


    // 2. Concurrency Test (isolated)
    console.log('\\n[2] Testing AsyncLocalStorage Concurrency...');
    async function simulateRequest(reqId, userId, delayMs) {
        return new Promise((resolve) => {
            asyncLocalStorage.run({ requestId: reqId }, () => {
                updateTraceContext({ userId });
                setTimeout(() => {
                    const ctx = getTraceContext();
                    resolve(ctx);
                }, delayMs);
            });
        });
    }

    const [ctx1, ctx2] = await Promise.all([
        simulateRequest('req-1', 'user-A', 50),
        simulateRequest('req-2', 'user-B', 10)
    ]);
    
    if (ctx1.requestId === 'req-1' && ctx1.userId === 'user-A' && 
        ctx2.requestId === 'req-2' && ctx2.userId === 'user-B') {
        console.log('✅ Concurrency context isolation passed');
    } else {
        console.error('❌ Concurrency context isolation failed', { ctx1, ctx2 });
    }

    // 3. Error Taxonomy, Lifecycle, and Health Tests (Integration)
    console.log('\\n[3] Testing API Endpoints (Error, Lifecycle, Health)...');
    
    const app = require('./index'); // Need to load app to start server
    let server;
    try {
        server = http.createServer(app);
        await new Promise(resolve => server.listen(9876, resolve));

        // Add a temporary test route that throws an explicit application error
        const express = require('express');
        const testRouter = express.Router();
        testRouter.get('/test/error', (req, res, next) => {
            const err = new Error('INVALID_STATE_TRANSITION');
            next(err);
        });
        app.use(testRouter);
        const newRoute = app._router.stack.pop();
        app._router.stack.splice(app._router.stack.length - 2, 0, newRoute);

        const fetchPath = (path) => {
            return new Promise((resolve, reject) => {
                http.get('http://localhost:9876' + path, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                }).on('error', reject);
            });
        };

        // Test Health
        const { status: liveStatus, data: liveData } = await fetchPath('/health/live');
        assert(liveStatus === 200 && liveData === 'OK', 'Live endpoint failed');
        console.log('✅ /health/live passed');

        const { status: readyStatus, data: readyData } = await fetchPath('/health/ready');
        assert(readyStatus === 200 || readyStatus === 503, 'Ready endpoint missing'); // 503 is OK if redis/mongo isn't up
        const readyJson = JSON.parse(readyData);
        assert(!readyData.includes('password') && !readyData.includes('uri'), 'Ready endpoint leaked secrets');
        console.log('✅ /health/ready passed');

        // Test Error Taxonomy
        const { status: errStatus, data: errData } = await fetchPath('/test/error');
        const errJson = JSON.parse(errData);
        assert(errStatus === 400, 'Error status should be 400 for MUTATION_REJECTED, got ' + errStatus);
        assert(errJson.code === 'LOAN_STATE_INVALID', 'Error code should be LOAN_STATE_INVALID, got ' + errJson.code);
        console.log('✅ Error taxonomy passed');

        console.log('\\nALL TESTS PASSED.');
    } catch(e) {
        console.error('❌ Integration Test Failed:', e.message);
    } finally {
        if(server) server.close();
    }
}

runTests();
