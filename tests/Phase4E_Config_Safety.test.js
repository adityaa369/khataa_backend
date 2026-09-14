const assert = require('assert');
const { validateConfig } = require('../utils/configValidator');
const mongoose = require('mongoose');

describe('Suite 13: Configuration Failure Safety', () => {
    let originalEnv;
    let exitStub;
    let consoleErrorStub;

    beforeEach(() => {
        originalEnv = { ...process.env };
        exitStub = process.exit;
        consoleErrorStub = console.error;
        process.exit = (code) => { throw new Error(`Process.exit called with code ${code}`); };
        console.error = () => {};
    });

    afterEach(() => {
        process.env = originalEnv;
        process.exit = exitStub;
        console.error = consoleErrorStub;
    });

    it('should fail startup if MIGRATION_SECRET is missing', () => {
        delete process.env.MIGRATION_SECRET;
        try {
            validateConfig();
            assert.fail('Should have exited');
        } catch (err) {
            assert.strictEqual(err.message, 'Process.exit called with code 1');
        }
    });

    it('should fail startup if JWT_SECRET is missing', () => {
        delete process.env.JWT_SECRET;
        try {
            validateConfig();
            assert.fail('Should have exited');
        } catch (err) {
            assert.strictEqual(err.message, 'Process.exit called with code 1');
        }
    });

    it('should fail safely if Mongo credential is invalid', async () => {
        const invalidUri = 'mongodb+srv://invalid_user:invalid_pass@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority';
        try {
            await mongoose.connect(invalidUri, { serverSelectionTimeoutMS: 2000 });
            assert.fail('Should not have connected');
        } catch (err) {
            assert.ok(err.message.includes('bad auth') || err.message.includes('Authentication failed') || err.message.includes('ECONNREFUSED') || err.message.includes('timeout') || err.message.includes('AtlasError'));
        }
    });

    it('should safely disable Firebase if FIREBASE_SERVICE_ACCOUNT is missing', () => {
        delete process.env.FIREBASE_SERVICE_ACCOUNT;
        const admin = require('../config/firebase');
        assert.ok(admin);
    });
});
