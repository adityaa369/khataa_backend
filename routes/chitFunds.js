const express = require('express');
const {
    createChitFund,
    getVacantChits,
    joinChit,
    getMyChits,
    getPendingAuctions,
    authorizeBid,
    payInstallment
} = require('../controllers/chitFunds');

const { protect } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(protect);

router.route('/create').post(createChitFund);
router.route('/vacant').get(getVacantChits);
router.route('/:id/join').post(joinChit);
router.route('/:id/installments').post(payInstallment);
router.route('/my').get(getMyChits);
router.route('/auctions/pending').get(getPendingAuctions);
router.route('/auctions/:id/authorize').post(authorizeBid);

module.exports = router;
