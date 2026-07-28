const express = require('express');
const { protect } = require('../middleware/auth');
const chitFundsController = require('../controllers/chitFunds');

const router = express.Router();

// --- Create ---
router.post('/', protect, chitFundsController.createChitFund);

// --- Specific list routes (must come before /:id) ---
router.get('/managed', protect, chitFundsController.getManagedChitFunds);
router.get('/joined', protect, chitFundsController.getJoinedChitFunds);
router.get('/invites', protect, chitFundsController.getPendingInvites);

// --- Invite actions ---
router.post('/:id/invite', protect, chitFundsController.sendInvite);
router.post('/invites/:inviteId/accept', protect, chitFundsController.acceptInvite);
router.post('/invites/:inviteId/decline', protect, chitFundsController.declineInvite);

// --- Chit lifecycle ---
router.post('/:id/start', protect, chitFundsController.startChitFund);
router.post('/:id/open-auction-month', protect, chitFundsController.openAuctionMonth);

// --- Bidding ---
router.post('/:id/bid', protect, chitFundsController.submitBid);
router.get('/:id/bids', protect, chitFundsController.getBids);
router.post('/:id/declare-winner', protect, chitFundsController.declareWinner);

// --- Payment verification (owner) ---
router.post('/:id/verify-payment', protect, chitFundsController.verifyMonthPayment);

// --- Detail views ---
router.get('/:id/member-detail', protect, chitFundsController.getMemberDetail);
router.get('/:id', protect, chitFundsController.getChitDashboard);

// --- Delete ---
router.delete('/:id', protect, chitFundsController.deleteChitFund);

module.exports = router;

