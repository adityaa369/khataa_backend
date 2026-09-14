const express = require('express');
const { createIntent } = require('../controllers/intents');
const { protect } = require('../middleware/auth');
const { requireFinancialEligibility } = require('../middleware/eligibilityGuard');

const router = express.Router();

router.use(protect);
router.use(requireFinancialEligibility);

router.post('/', createIntent);

module.exports = router;
