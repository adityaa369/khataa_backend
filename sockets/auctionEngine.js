const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ChitAuction = require('../models/ChitAuction');
const BidService = require('../services/BidService');
const Money = require('../utils/money');
const AuthorizationService = require('../services/AuthorizationService');
const RateLimitService = require('../services/RateLimitService');

    // Helper to re-verify authentication on sensitive events
    // This prevents a long-lived socket from staying authorized after the 15m AT expires or the user logs out.
    const verifySocketAuth = async (socket) => {
        const token = socket.handshake.auth.token || socket.handshake.headers['authorization'];
        if (!token) throw new Error('Authentication required');
        
        const actualToken = token.startsWith('Bearer ') ? token.split(' ')[1] : token;
        
        try {
            const decoded = jwt.verify(actualToken, process.env.JWT_SECRET);
            return decoded;
        } catch (err) {
            if (process.env.JWT_SECRET_PREVIOUS) {
                return jwt.verify(actualToken, process.env.JWT_SECRET_PREVIOUS);
            }
            throw err;
        }
    };

function initAuctionEngine(server) {
    let ioInstance;
    const io = new Server(server, { cors: { credentials: true } });
    ioInstance = io;

        io.use(async (socket, next) => {
        try {
            const ip = socket.handshake.address;
            const key = RateLimitService.generateKey('ip', ip, 'ws_connect');
            const { allowed } = await RateLimitService.consume(key, 20, 60, false); // Max 20 connections per minute per IP
            if (!allowed) return next(new Error('Too many connection attempts'));
            const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
            if (!token) return next(new Error('Authentication required'));
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findOne({ id: decoded.id });
            if (!user) return next(new Error('User not found'));
            socket.user = user; 
            next();
        } catch (err) {
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', (socket) => {
                socket.on('join_auction', async (data) => {
            const { auctionId } = data;
            
            try {
                const auction = await ChitAuction.findById(auctionId);
                if (!auction) return socket.emit('auction_error', { message: 'Auction not found' });

                // P0: Authorization BEFORE joining the room
                const canView = await AuthorizationService.canViewChit(socket.user.id, auction.groupId);
                if (!canView) {
                    return socket.emit('auction_error', { message: 'Unauthorized' });
                }

                socket.join(auctionId);
                
                if (auction.status === 'open') {
                    socket.emit('auction_sync', {
                        lowestBid: auction.currentLowestBid ? Money.toRupees(auction.currentLowestBid) : null,
                        winnerUser: auction.currentWinner,
                        endTime: new Date(auction.endTime).getTime()
                    });
                }
            } catch (e) {
                console.error('[AuctionSocket] Sync error:', e);
            }
        });

                        socket.on('place_bid', async (data) => {
            let userId;
            try {
                // Protocol Hardening: Re-verify authentication lifecycle dynamically
                const decoded = await verifySocketAuth(socket);
                userId = decoded.id;
            } catch (err) {
                socket.emit('error', { message: 'Session expired or revoked. Please reconnect.' });
                socket.disconnect(true);
                return;
            }
            
            const { auctionId, bidAmount, idempotencyKey } = data;
            
            try {
                // Tier 2: Bid Burst Protection
                const key = RateLimitService.generateKey('user', userId, 'bid');
                const { allowed } = await RateLimitService.consume(key, 10, 10, false); // 10 bids per 10s
                if (!allowed) {
                    return socket.emit('bid_error', { message: 'Rate limit exceeded, please slow down.' });
                }
                if (!bidAmount || isNaN(bidAmount) || bidAmount <= 0) return;
                const bidDiscountPaise = Money.toPaise(bidAmount);

                // Transport delegates purely to domain service
                const result = await BidService.placeBid({ 
                    auctionId, 
                    userId, 
                    bidDiscountPaise,
                    idempotencyKey
                });

                if (result.success && !result.cached) {
                    // Post-commit broadcast. If this fails, DB is still authoritative.
                    io.to(auctionId).emit('bid_update', {
                        lowestBid: Money.toRupees(result.auction.currentLowestBid),
                        winnerUser: result.auction.currentWinner,
                        timestamp: Date.now()
                    });
                }
            } catch (err) {
                // Return structured error to the specific socket that placed the bid
                socket.emit('bid_error', { message: err.message });
            }
        });
    });

    return io;
}

module.exports = { initAuctionEngine, getIo: () => ioInstance };






