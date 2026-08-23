const ChitSubscription = require('../models/ChitSubscription');
const Loan = require('../models/Loan');

class AuthorizationService {
    /**
     * Checks if a user is an active member or the owner of a Chit Fund.
     */
    static async canViewChit(userId, chitId) {
        // Find if user is a subscriber
        const sub = await ChitSubscription.findOne({ chitFund: chitId, user: userId, status: 'active' });
        return !!sub;
    }

    /**
     * Checks if a user is the explicit owner of a Chit Fund.
     */
    static canManageChit(userId, chit) {
        if (!chit || !chit.owner) return false;
        return chit.owner === userId;
    }

    /**
     * Checks if a user is eligible to bid in a specific chit fund auction.
     */
    static async canBid(userId, chitId) {
        // User must be an active subscriber
        const sub = await ChitSubscription.findOne({ chitFund: chitId, user: userId, status: 'active' });
        if (!sub) return false;

        // User must not have already won a previous auction in this group
        if (sub.hasWonAuction) return false;

        return true;
    }

    /**
     * Checks if a user can view or interact with a loan.
     */
    static canViewLoan(userId, loan) {
        if (!loan) return false;
        return (loan.lender === userId || loan.borrower.toString() === userId);
    }
}

module.exports = AuthorizationService;
