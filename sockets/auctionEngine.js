const { Server } = require('socket.io');
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ChitLedger = require('../models/ChitLedger');
const ChitGroup = require('../models/ChitGroup');

// We use an in-memory map or Redis for active timers. 
// For single-node simplicity during dev, we can use an in-memory map, 
// but we will prepare the Redis client as requested.
let redisClient;
try {
    redisClient = new Redis(process.env.REDIS_URI || 'redis://127.0.0.1:6379');
} catch (e) {
    console.error('[AuctionEngine] Redis connection failed, falling back to memory if needed.', e);
}

const activeAuctions = {}; // In-memory fallback/cache

function initAuctionEngine(server) {
    const io = new Server(server, {
        cors: {
            origin: process.env.NODE_ENV === 'production'
                ? ['https://khataa-backend.onrender.com']
                : ['http://localhost:3000', 'http://localhost:8080'],
            credentials: true
        }
    });

    // Auth middleware — runs before any connection is accepted
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
            if (!token) {
                return next(new Error('Authentication required'));
            }
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findOne({ id: decoded.id });
            if (!user) return next(new Error('User not found'));
            socket.user = user; // attach user to socket
            next();
        } catch (err) {
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', (socket) => {
        console.log(`[Auction] Socket connected: ${socket.id}`);

        // Join an auction room
        socket.on('join_auction', async (data) => {
            const { ledgerId } = data;
            const userId = socket.user.id;
            socket.join(ledgerId);
            console.log(`[Auction] User ${userId} joined room ${ledgerId}`);

            // Send current state
            if (activeAuctions[ledgerId]) {
                socket.emit('auction_sync', activeAuctions[ledgerId]);
            } else {
                // Check DB
                try {
                    const ledger = await ChitLedger.findById(ledgerId).populate('groupId');
                    if (ledger && ledger.status === 'open') {
                        activeAuctions[ledgerId] = {
                            lowestBid: ledger.winningBidDiscount || ledger.groupId.totalValue * 0.4, // Max allowed bid initially
                            winnerUser: null,
                            endTime: new Date(ledger.auctionEndTime).getTime()
                        };
                        socket.emit('auction_sync', activeAuctions[ledgerId]);
                    }
                } catch (e) {
                    console.error('[Auction] Sync error:', e);
                }
            }
        });

        // Handle incoming bids
        socket.on('place_bid', async (data) => {
            const { ledgerId, bidAmount } = data;
            const userId = socket.user.id;
            
            const auction = activeAuctions[ledgerId];
            if (!auction) return; // Auction not active

            const now = Date.now();
            if (now > auction.endTime) return; // Time expired

            // Core atomic logic: The bid must be lower than the current lowest bid
            if (bidAmount < auction.lowestBid) {
                auction.lowestBid = bidAmount;
                auction.winnerUser = userId;
                
                // Broadcast to all clients instantly
                io.to(ledgerId).emit('bid_update', {
                    lowestBid: bidAmount,
                    winnerUser: userId,
                    timestamp: now
                });
            }
        });

        socket.on('disconnect', () => {
            console.log(`[Auction] Socket disconnected: ${socket.id}`);
        });
    });

    // Background worker to check expired auctions and commit to DB
    setInterval(async () => {
        const now = Date.now();
        for (const [ledgerId, auction] of Object.entries(activeAuctions)) {
            if (now >= auction.endTime) {
                // Auction ended! Lock state and commit.
                const finalBid = auction.lowestBid;
                const finalWinner = auction.winnerUser;
                
                delete activeAuctions[ledgerId]; // Remove from memory
                io.to(ledgerId).emit('auction_ended', { winnerUser: finalWinner, lowestBid: finalBid });

                try {
                    const ledger = await ChitLedger.findById(ledgerId).populate('groupId');
                    if (ledger && ledger.status === 'open') {
                        ledger.status = 'processing_validation';
                        ledger.winningBidDiscount = finalBid;
                        ledger.winnerUser = finalWinner;

                        // Phase 3: Mathematical Engine Lifecycle
                        const group = ledger.groupId;
                        const commission = (group.totalValue * group.commissionPercentage) / 100;
                        ledger.commissionExtracted = commission;

                        // Dividend Calculation
                        // (Winning Bid Discount - Commission) / Members
                        const dividendPool = finalBid - commission;
                        const membersCount = group.maxSubscribers;
                        
                        let dividendPerHead = 0;
                        let netPayable = (group.totalValue / group.durationMonths); // Base EMI

                        if (dividendPool > 0) {
                            dividendPerHead = Math.floor(dividendPool / membersCount);
                        }

                        netPayable = netPayable - dividendPerHead;

                        ledger.dividendPerHead = dividendPerHead;
                        ledger.netPayable = netPayable;

                        await ledger.save();
                        console.log(`[Auction] Committed Ledger ${ledgerId} -> Winner: ${finalWinner}, NetPayable: ${netPayable}`);
                    }
                } catch (e) {
                    console.error('[Auction] Commit Error:', e);
                }
            }
        }
    }, 1000); // Check every second

    return io;
}

module.exports = initAuctionEngine;
