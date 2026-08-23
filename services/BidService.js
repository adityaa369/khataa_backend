const mongoose = require('mongoose');
const ChitAuction = require('../models/ChitAuction');
const ChitBid = require('../models/ChitBid');
const { withTransaction } = require('../utils/dbTransaction');
const AuthorizationService = require('./AuthorizationService');

class BidService {
    /**
     * Core business logic for placing a bid.
     * Uses Option A (Transactional Boundary) to atomically update the auction state
     * AND generate the immutable audit event (ChitBid) without dual-write gaps.
     */    static async placeBid({ auctionId, userId, bidDiscountPaise, idempotencyKey }) {
        if (!auctionId || !userId || bidDiscountPaise === undefined) {
            throw new Error('VALIDATION_ERROR: Missing required fields');
        }
        
        // Strict Numeric Hardening
        if (typeof bidDiscountPaise !== 'number' || !Number.isInteger(bidDiscountPaise)) {
            throw new Error('VALIDATION_ERROR: bidDiscountPaise must be a valid integer');
        }
        if (bidDiscountPaise < 0 || bidDiscountPaise > 1000000000) { // Limit to 1 Crore rupees maximum
            throw new Error('VALIDATION_ERROR: bidDiscountPaise is out of acceptable bounds');
        }

        // Idempotency check at the service level (if provided via WS) at the service level (if provided via WS)
        if (idempotencyKey) {
            const existingBid = await ChitBid.findOne({ idempotencyKey, userId });
            if (existingBid) {
                return { success: true, cached: true, bid: existingBid };
            }
        }

                const auction = await ChitAuction.findById(auctionId);
        if (!auction) throw new Error('AUCTION_NOT_FOUND');

        // P0: Enforce strict Chit membership and bidding eligibility
        const isEligible = await AuthorizationService.canBid(userId, auction.groupId);
        if (!isEligible) throw new Error('UNAUTHORIZED: Not an eligible member for this auction');

        return await withTransaction(async (session) => {
            // 1. Atomically Validate and Update Auction State
            // Using findOneAndUpdate with strict filters acts as an atomic Check-And-Set.
            const now = new Date();
            
            const auctionUpdate = await ChitAuction.findOneAndUpdate(
                {
                    _id: auctionId,
                    status: 'open',
                    endTime: { $gt: now },
                    $or: [
                        { currentLowestBid: { $gt: bidDiscountPaise } },
                        { currentLowestBid: 0 },
                        { currentLowestBid: null }
                    ]
                },
                {
                    $set: {
                        currentLowestBid: bidDiscountPaise,
                        currentWinner: userId
                    }
                },
                { new: true, session }
            );

            if (!auctionUpdate) {
                // Determine exactly why it failed for better client feedback
                const currentAuction = await ChitAuction.findById(auctionId).session(session);
                if (!currentAuction) throw new Error('AUCTION_NOT_FOUND');
                if (currentAuction.status !== 'open' || currentAuction.endTime <= now) throw new Error('AUCTION_CLOSED');
                if (currentAuction.currentLowestBid <= bidDiscountPaise) throw new Error('BID_NOT_COMPETITIVE');
                throw new Error('UNKNOWN_BID_REJECTION');
            }

            // 2. Create the Immutable Audit Event within the exact same transaction
            const bidEvent = new ChitBid({
                auctionId: auctionUpdate._id,
                groupId: auctionUpdate.groupId,
                cycleIndex: auctionUpdate.cycleIndex,
                userId: userId,
                bidDiscountPaise: bidDiscountPaise,
                idempotencyKey: idempotencyKey || null
            });

            await bidEvent.save({ session });

            return {
                success: true,
                cached: false,
                auction: auctionUpdate,
                bid: bidEvent
            };
        });
    }
}

module.exports = BidService;


