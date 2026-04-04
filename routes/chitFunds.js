const express = require('express');
const {
    createChitFund,
    getVacantChits,
    joinChit,
    getMyChits,
    getPendingAuctions,
    authorizeBid,
    finalizeAuction,
    payInstallment,
    verifyInstallment,
    sendInvite,
    getMyInvites,
    respondToInvite,
    getChitMembers,
    getAdminDashboard,
    deleteChitFund
} = require('../controllers/chitFunds');

const { protect } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(protect);

router.route('/create').post(createChitFund);
router.route('/vacant').get(getVacantChits);
router.route('/:id/members').get(getChitMembers);
router.route('/:id/admin-dashboard').get(getAdminDashboard);
router.route('/:id/join').post(joinChit);
router.route('/:id/installments').post(payInstallment);
router.route('/:id/verify-installment').post(verifyInstallment);
router.route('/:id/invite').post(sendInvite);

router.route('/invites').get(getMyInvites);
router.route('/invites/:id/respond').post(respondToInvite);

router.route('/my').get(getMyChits);
router.route('/auctions/pending').get(getPendingAuctions);
router.route('/auctions/:id/authorize').post(authorizeBid);
router.route('/:id/finalize-auction').post(finalizeAuction);
router.route('/:id').delete(deleteChitFund);

module.exports = router;
