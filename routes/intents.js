const express = require('express');
const { createIntent, getIntent, getIntentStatus, rejectIntent } = require('../controllers/intents');
const { protect } = require('../middleware/auth');
const { requireFinancialEligibility } = require('../middleware/eligibilityGuard');

const router = express.Router();

router.use(protect);

router.get('/:intentId', getIntent);
router.get('/:intentId/status', getIntentStatus);
router.post('/:intentId/reject', rejectIntent);

router.use(requireFinancialEligibility);
router.post('/', createIntent);

module.exports = router;
