const express = require('express');
const { downloadDocument } = require('../controllers/documents');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.get('/:id/download', protect, downloadDocument);

// Alias to maintain compatibility if some flutter code hits /:id without /download
router.get('/:id', protect, downloadDocument);

module.exports = router;
