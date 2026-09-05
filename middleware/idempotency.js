const IdempotencyKey = require('../models/IdempotencyKey');
const crypto = require('crypto');
const { triggerAlert } = require('../utils/telemetry');
const logger = require('../utils/logger');
const { metrics } = require('./metrics');

// Simple deterministic JSON stringifier for canonical hashing
const stringifyDeterministic = (obj) => {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stringifyDeterministic).join(',') + ']';
    const keys = Object.keys(obj).sort();
    const parts = keys.map(k => JSON.stringify(k) + ':' + stringifyDeterministic(obj[k]));
    return '{' + parts.join(',') + '}';
};

const requireIdempotency = async (req, res, next) => {
    const key = req.headers['x-idempotency-key'];
    
    if (!key) {
        return res.status(400).json({ success: false, message: 'Idempotency key is required.' });
    }
    
    const userId = req.user ? req.user.id : 'anonymous';
    
    // Generate canonical payload hash
    const canonicalBody = stringifyDeterministic(req.body || {});
    const payloadHash = crypto.createHash('sha256').update(canonicalBody).digest('hex');

    try {
        let record;
        let isNewRecord = false;
        try {
            record = await IdempotencyKey.create({
                key: key,
                user: userId,
                payloadHash: payloadHash,
                requestPath: req.originalUrl,
                status: 'IN_PROGRESS'
            });
            isNewRecord = true;
            // Also enrich context with idempotency key
            require('../utils/asyncContext').updateTraceContext({ idempotencyKey: key });
        } catch (err) {
            if (err.code === 11000) {
                record = await IdempotencyKey.findOne({ key, user: userId });
                if (!record) {
                    return res.status(500).json({ success: false, message: 'Idempotency conflict error' });
                }
            } else {
                throw err;
            }
        }

        if (!isNewRecord) {
            // Conflict check
            if (record.payloadHash !== payloadHash) {
                logger.error({
                    type: 'operational_anomaly',
                    anomaly: 'idempotency_conflict',
                    severity: 'HIGH',
                    idempotencyKey: key,
                    userId,
                    path: req.originalUrl
                });
                return res.status(409).json({ 
                    success: false, 
                    code: 'IDEMPOTENCY_CONFLICT',
                    message: 'A previous request with this idempotency key had a conflicting payload.' 
                });
            }

            if (record.status === 'COMPLETED') {
                logger.info({
                    type: 'idempotency_replay',
                    idempotencyKey: key,
                    path: req.originalUrl,
                    userId
                });
                
                metrics.financial.idempotencyReplays++;
                return res.status(record.responseStatus || 200).json(record.responseBody);
            }

            if (record.status === 'IN_PROGRESS' && record._id.toString() !== (req.idempotencyRecordId || '')) {
                return res.status(409).json({ 
                    success: false, 
                    code: 'IDEMPOTENCY_CONFLICT',
                    message: 'A transaction with this idempotency key is already in progress. Please wait.' 
                });
            }
        }

        req.idempotencyRecordId = record._id.toString();

        const originalJson = res.json;
        res.json = function (body) {
            res.json = originalJson;
            IdempotencyKey.updateOne(
                { _id: record._id },
                { $set: { status: 'COMPLETED', responseStatus: res.statusCode, responseBody: body } }
            ).catch(err => console.error('[Idempotency] Failed to save completed response:', err));
            return originalJson.call(this, body);
        };

        next();
    } catch (error) {
        console.error('[Idempotency] Middleware error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error enforcing idempotency.' });
    }
};

module.exports = { requireIdempotency };
