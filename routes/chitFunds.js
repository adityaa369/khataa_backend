const express = require('express');
const { protect } = require('../middleware/auth');
const {
    createChitFund,
    sendInvite,
    getPendingInvites,
    acceptInvite,
    getManagedChitFunds,
    getJoinedChitFunds,
    startChitFund,
    submitBid,
    getBids,
    declareWinner
} = require('../controllers/chitFunds');

const router = express.Router();

router.post('/', protect, createChitFund);
router.get('/managed', protect, getManagedChitFunds);
router.get('/joined', protect, getJoinedChitFunds);

router.get('/invites', protect, getPendingInvites);
router.post('/:id/invite', protect, sendInvite);
router.post('/invites/:inviteId/accept', protect, acceptInvite);

router.post('/:id/start', protect, startChitFund);

router.post('/:id/bid', protect, submitBid);
router.get('/:id/bids', protect, getBids);
router.post('/:id/declare-winner', protect, declareWinner);

module.exports = router;
