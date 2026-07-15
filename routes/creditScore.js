const express = require('express');
const { getCreditScore, getInsights } = require('../controllers/creditScore');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.get('/', protect, getCreditScore);
router.get('/insights', protect, getInsights);

module.exports = router;
