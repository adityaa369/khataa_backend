const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// One-time secret — delete this file after use
const SECRET = 'CLEAR_KHATHA_DEMO_9x7z';

router.get('/' + SECRET, async (req, res) => {
    try {
        const db = mongoose.connection.db;

        const collections = [
            'users',
            'otps',
            'loans',
            'financialtransactions',
            'transactionintents',
            'fs.files',
            'fs.chunks',
            'notifications',
        ];

        const results = {};
        for (const name of collections) {
            try {
                const result = await db.collection(name).deleteMany({});
                results[name] = result.deletedCount + ' deleted';
            } catch (e) {
                results[name] = 'skipped: ' + e.message;
            }
        }

        return res.json({
            success: true,
            message: 'All user data cleared. Schema and indexes preserved.',
            results
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
