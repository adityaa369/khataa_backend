const IdempotencyKey = require('../models/IdempotencyKey');

const requireIdempotency = async (req, res, next) => {
    const key = req.headers['x-idempotency-key'];
    
    if (!key) {
        return res.status(400).json({ success: false, message: 'Idempotency key is required.' });
    }
    
    const userId = req.user ? req.user.id : 'anonymous';

    try {
        let record;
        try {
            record = await IdempotencyKey.create({
                key: key,
                user: userId,
                requestPath: req.originalUrl,
                status: 'IN_PROGRESS'
            });
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

        if (record.status === 'COMPLETED') {
            console.log(`[Idempotency] Returning cached response for key: ${key}`);
            return res.status(record.responseStatus || 200).json(record.responseBody);
        }

        if (record.status === 'IN_PROGRESS' && record._id.toString() !== (req.idempotencyRecordId || '')) {
            return res.status(409).json({ success: false, message: 'A transaction with this idempotency key is already in progress. Please wait.' });
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
