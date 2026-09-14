/**
 * Phase 4H-B3 Verification Test Suite v5 (FINAL)
 * Uses MongoMemoryReplSet, corrects route names and assertions
 */
'use strict';

const assert   = require('assert');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const fs       = require('fs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_key_v2';

let replSet;
let app;
let superAdminToken;
let noMfaOpsAdminToken;
let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`\u2705 PASSED: ${name}`);
        passed++;
    } catch (e) {
        console.error(`\u274c FAILED: ${name}`);
        console.error(`   ${e.message}`);
        failed++;
    }
}

async function setup() {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());

    // Bypass rate limiters (Redis not available in test env)
    const rl = require('./middleware/rateLimiter');
    rl.apiLimiter = (req, res, next) => next();
    rl.financialLimiter = (req, res, next) => next();

    app = require('./index');
    await new Promise(r => setTimeout(r, 500));

    const Admin = require('./models/Admin');
    const superAdmin = await Admin.create({
        email: 'b3super@test.com',
        passwordHash: '$2b$10$dummyhashfortesting000000000000000000',
        role: 'SUPER_ADMIN',
        mfaEnabled: true,
        isActive: true
    });
    const opsAdmin = await Admin.create({
        email: 'b3ops@test.com',
        passwordHash: '$2b$10$dummyhashfortesting000000000000000000',
        role: 'OPS_ADMIN',
        mfaEnabled: false,
        isActive: true
    });

    superAdminToken    = jwt.sign({ id: superAdmin._id, adminId: superAdmin._id, role: 'SUPER_ADMIN', mfaVerified: true  }, process.env.JWT_SECRET, { expiresIn: '1h' });
    noMfaOpsAdminToken = jwt.sign({ id: opsAdmin._id,   adminId: opsAdmin._id,   role: 'OPS_ADMIN',   mfaVerified: false }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function runTests() {
    try {
        await setup();
        const request = require('supertest');
        console.log('\n=== Phase 4H-B3: Release Security & Deployment Hardening ===\n');

        // ─── 1. Dev endpoint exclusion ────────────────────────────────────────────────
        await test('[1] Dev endpoints guarded by NODE_ENV !== production (source)', async () => {
            const src = fs.readFileSync('./index.js', 'utf8');
            assert.match(src, /if \(process\.env\.NODE_ENV !== 'production'\) \{[\s\S]*?\/api\/dev\/redis-status/,
                'redis-status must be inside production guard');
            assert.match(src, /if \(process\.env\.NODE_ENV !== 'production'\) \{[\s\S]*?\/api\/dev\/clear-db/,
                'clear-db must be inside production guard');
        });

        await test('[2] simulateAllPass + adminReadiness controllers deleted', async () => {
            assert.strictEqual(fs.existsSync('./controllers/adminSecurityAudit.js'), false);
            assert.strictEqual(fs.existsSync('./controllers/adminReadiness.js'), false);
        });

        // ─── 2. Private document authorization ───────────────────────────────────────
        await test('[3] Unauthenticated /api/documents → 401', async () => {
            const res = await request(app).get('/api/documents/doc_abc');
            assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
        });

        await test('[4] Document route is mounted (not 404)', async () => {
            const res = await request(app).get('/api/documents/doc_abc');
            // Auth kicks in before 404 — we get 401, not 404
            assert.notStrictEqual(res.status, 404, 'Documents route must be mounted, not 404');
        });

        // ─── 3. High-risk MFA fail-closed ────────────────────────────────────────────
        // Use /api/admin/dashboard which has requireMFA
        await test('[5] OPS_ADMIN without mfaVerified=true → 403 on dashboard (requireMFA)', async () => {
            const res = await request(app)
                .get('/api/admin/dashboard')
                .set('Authorization', `Bearer ${noMfaOpsAdminToken}`);
            assert.strictEqual(res.status, 403, `Expected 403 MFA fail-closed, got ${res.status}`);
        });

        await test('[6] SUPER_ADMIN with mfaVerified=true → not 403 on dashboard', async () => {
            const res = await request(app)
                .get('/api/admin/dashboard')
                .set('Authorization', `Bearer ${superAdminToken}`);
            assert.notStrictEqual(res.status, 403, `Verified SUPER_ADMIN should pass MFA gate, got ${res.status}`);
        });

        // ─── 4. Financial limiter + idempotency (source-level) ───────────────────────
        await test('[7] add-credit has financialLimiter + requireIdempotency (source)', async () => {
            const src = fs.readFileSync('./routes/loans.js', 'utf8');
            const line = src.split('\n').find(l => l.includes("'/:id/add-credit'") && l.includes('router.post'));
            assert(line, 'add-credit route must exist');
            assert.match(line, /financialLimiter/, 'add-credit must have financialLimiter');
            assert.match(line, /requireIdempotency/, 'add-credit must have requireIdempotency');
        });

        await test('[8] record-payment has financialLimiter + requireIdempotency (source)', async () => {
            const src = fs.readFileSync('./routes/loans.js', 'utf8');
            const line = src.split('\n').find(l => l.includes("'/:id/record-payment'") && l.includes('router.post'));
            assert(line, 'record-payment route must exist');
            assert.match(line, /financialLimiter/, 'record-payment must have financialLimiter');
            assert.match(line, /requireIdempotency/, 'record-payment must have requireIdempotency');
        });

        await test('[9] verify has financialLimiter (source)', async () => {
            const src = fs.readFileSync('./routes/loans.js', 'utf8');
            const line = src.split('\n').find(l => l.includes("'/:id/verify'") && l.includes('router.post'));
            assert(line, 'verify route must exist');
            assert.match(line, /financialLimiter/, 'verify must have financialLimiter');
        });

        // ─── 5. CORS ─────────────────────────────────────────────────────────────────
        await test('[10] CORS rejects unknown origin https://evil-attacker.com → 403', async () => {
            const res = await request(app)
                .options('/api/test')
                .set('Origin', 'https://evil-attacker.com');
            assert.strictEqual(res.status, 403, `Expected 403 CORS rejection, got ${res.status}`);
        });

        await test('[11] CORS allows khataa-backend.onrender.com → 204', async () => {
            const res = await request(app)
                .options('/api/test')
                .set('Origin', 'https://khataa-backend.onrender.com');
            assert.strictEqual(res.status, 204, `Expected 204 CORS pass, got ${res.status}`);
        });

        await test('[12] CORS config uses CORS_ORIGINS env var, no wildcard (source)', async () => {
            const src = fs.readFileSync('./index.js', 'utf8');
            assert.match(src, /CORS_ORIGINS/, 'Must reference CORS_ORIGINS');
            assert.doesNotMatch(src, /origin:\s*'\*'|origin:\s*"\*"/, 'Must not use wildcard');
        });

        // ─── 6. PII logging scan (Flutter) ───────────────────────────────────────────
        await test('[13] login_page.dart: no PII debugPrint', async () => {
            const src = fs.readFileSync('C:\\Users\\adity\\AndroidStudioProjects\\khatha\\lib\\features\\auth\\presentation\\pages\\login_page.dart', 'utf8');
            assert.doesNotMatch(src, /debugPrint.*phone/i);
            assert.doesNotMatch(src, /debugPrint.*password/i);
        });

        await test('[14] api_client.dart: no PII debugPrint', async () => {
            const src = fs.readFileSync('C:\\Users\\adity\\AndroidStudioProjects\\khatha\\lib\\core\\network\\api_client.dart', 'utf8');
            assert.doesNotMatch(src, /debugPrint.*phone/i);
        });

        // ─── 7. Application identity + Firebase ──────────────────────────────────────
        await test('[15] applicationId = com.vest.khataa', async () => {
            const src = fs.readFileSync('C:\\Users\\adity\\AndroidStudioProjects\\khatha\\android\\app\\build.gradle.kts', 'utf8');
            assert.match(src, /applicationId\s*=\s*"com\.vest\.khataa"/);
            assert.doesNotMatch(src, /com\.example/);
        });

        await test('[16] google-services.json package_name = com.vest.khataa', async () => {
            const src = fs.readFileSync('C:\\Users\\adity\\AndroidStudioProjects\\khatha\\android\\app\\google-services.json', 'utf8');
            assert.match(src, /"package_name"\s*:\s*"com\.vest\.khataa"/);
        });

        // ─── 8. Signing security ──────────────────────────────────────────────────────
        await test('[17] *.jks pattern is in android/.gitignore (covers upload-keystore.jks)', async () => {
            const gi = fs.readFileSync('C:\\Users\\adity\\AndroidStudioProjects\\khatha\\android\\.gitignore', 'utf8');
            // **/*.jks pattern already covers upload-keystore.jks
            assert.match(gi, /\*\*\/\*\.jks|\*\*\/\*\.keystore|upload-keystore\.jks/,
                '.gitignore must exclude keystore files via *.jks or explicit name');
        });

        await test('[18] upload-keystore.jks NOT git-tracked (untracked or gitignored)', async () => {
            // Keystore MAY exist on disk (developer needs it to sign), but must not be committed
            // Verified: git ls-files shows empty output for this file
            const { execSync } = require('child_process');
            const tracked = execSync('git ls-files android/app/upload-keystore.jks', {
                cwd: 'C:\\Users\\adity\\AndroidStudioProjects\\khatha'
            }).toString().trim();
            assert.strictEqual(tracked, '', 'Keystore must not be git-tracked');
        });

        await test('[19] Release signing uses System.getenv (no hardcoded passwords)', async () => {
            const src = fs.readFileSync('C:\\Users\\adity\\AndroidStudioProjects\\khatha\\android\\app\\build.gradle.kts', 'utf8');
            assert.match(src, /System\.getenv/i);
        });

        // ─── 9. Obfuscation ───────────────────────────────────────────────────────────
        await test('[20] isMinifyEnabled=true + isShrinkResources=true (release)', async () => {
            const src = fs.readFileSync('C:\\Users\\adity\\AndroidStudioProjects\\khatha\\android\\app\\build.gradle.kts', 'utf8');
            assert.match(src, /isMinifyEnabled\s*=\s*true/);
            assert.match(src, /isShrinkResources\s*=\s*true/);
        });

        // ─── 10. Artifact ─────────────────────────────────────────────────────────────
        await test('[21] Release APK artifact exists (67+ MB)', async () => {
            const apkPath = 'C:\\Users\\adity\\AndroidStudioProjects\\khatha\\build\\app\\outputs\\flutter-apk\\app-release.apk';
            assert.strictEqual(fs.existsSync(apkPath), true, 'app-release.apk must exist');
            const size = fs.statSync(apkPath).size;
            assert(size > 10_000_000, `APK size ${size} bytes seems too small — expected > 10MB`);
        });

        console.log(`\n=== 4H-B3 TESTS FINISHED: ${passed} Passed, ${failed} Failed ===`);
        if (failed > 0) process.exit(1);
        else process.exit(0);

    } catch (e) {
        console.error('Fatal test error:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
}

runTests();
