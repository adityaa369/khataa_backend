const express = require('express');
const { getDocumentUrl } = require('../controllers/documents');
const { protect } = require('../middleware/auth');
const router = express.Router();

router.get('/:documentId', protect, getDocumentUrl);

module.exports = router;
