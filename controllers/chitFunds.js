const ChitFund = require('../models/ChitFund');
const ChitSubscription = require('../models/ChitSubscription');
const ChitInvite = require('../models/ChitInvite');
const ChitAuction = require('../models/ChitAuction');
const ChitBid = require('../models/ChitBid');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { cacheGet, cacheSet, cacheInvalidate, cacheInvalidatePattern } = require('../config/redis');

// @desc    Create a new Chit Fund Group
// @route   POST /api/chitfunds
// @access  Private
exports.createChitFund = async (req, res) => {
    try {
        const { name, totalValue, totalMonths, monthlySubscription, commissionPercentage, branchName } = req.body;
        
        const chit = await ChitFund.create({
            name,
            totalValue,
            totalMonths,
            monthlySubscription: monthlySubscription || (totalValue / totalMonths),
            commissionPercentage: commissionPercentage || 5,
            branchName: branchName || 'KPHB-CAO',
            owner: req.user.id,
            status: 'registration'
        });

        // Add owner as a subscriber
        await ChitSubscription.create({
            user: req.user.id,
            chitFund: chit._id,
            status: 'active'
        });
        
        chit.currentSubscribersCount = 1;
        await chit.save();

        await cacheInvalidate(`chit:managed:${req.user.id}`, `chit:joined:${req.user.id}`);
        res.status(201).json({ success: true, chit });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};


// @desc    Send an invite to a user
// @route   POST /api/chitfunds/:id/invite
// @access  Private (Owner only)
exports.sendInvite = async (req, res) => {
    try {
        const { receiverPhone } = req.body;
        const chitId = req.params.id;

        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit fund not found' });
        
        if (chit.owner !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only the owner can send invites' });
        }

        if (chit.currentSubscribersCount >= chit.totalMonths) {
            return res.status(400).json({ success: false, message: 'Chit group is already full' });
        }

        let receiverUser = await User.findOne({ phone: receiverPhone.replace(/^\+?91/, '') });
        
        const invite = await ChitInvite.create({
            chitFund: chitId,
            sender: req.user.id,
            receiverPhone,
            receiverId: receiverUser ? receiverUser.id : null,
            status: 'pending'
        });

        res.status(200).json({ success: true, message: 'Invite sent successfully', invite });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get pending invites for current user
// @route   GET /api/chitfunds/invites
// @access  Private
exports.getPendingInvites = async (req, res) => {
    try {
        const phone = String(req.user.phone).replace(/^\+?91/, '');
        const invites = await ChitInvite.find({ 
            $or: [ { receiverPhone: phone }, { receiverId: req.user.id } ],
            status: 'pending'
        }).populate('chitFund');

        res.status(200).json({ success: true, invites });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Accept invite
// @route   POST /api/chitfunds/invites/:inviteId/accept
// @access  Private
exports.acceptInvite = async (req, res) => {
    try {
        const invite = await ChitInvite.findById(req.params.inviteId);
        if (!invite) return res.status(404).json({ success: false, message: 'Invite not found' });

        const chit = await ChitFund.findById(invite.chitFund);
        if (chit.currentSubscribersCount >= chit.totalMonths) {
            return res.status(400).json({ success: false, message: 'Chit group is full' });
        }

        invite.status = 'accepted';
        await invite.save();

        await ChitSubscription.create({
            user: req.user.id,
            chitFund: chit._id,
            status: 'active'
        });

        chit.currentSubscribersCount += 1;
        await chit.save();

        res.status(200).json({ success: true, message: 'Joined chit fund successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get Chit Funds managed by user
// @route   GET /api/chitfunds/managed
// @access  Private
exports.getManagedChitFunds = async (req, res) => {
    try {
        const cacheKey = `chit:managed:${req.user.id}`;
        const cached = await cacheGet(cacheKey);
        if (cached) return res.status(200).json(cached);

        const chits = await ChitFund.find({ owner: req.user.id });
        await cacheSet(cacheKey, { success: true, chits }, 120);
        res.status(200).json({ success: true, chits });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get Chit Funds user has joined
// @route   GET /api/chitfunds/joined
// @access  Private
exports.getJoinedChitFunds = async (req, res) => {
    try {
        const cacheKey = `chit:joined:${req.user.id}`;
        const cached = await cacheGet(cacheKey);
        if (cached) return res.status(200).json(cached);

        const subscriptions = await ChitSubscription.find({ user: req.user.id }).populate('chitFund');
        const chits = subscriptions.map(sub => sub.chitFund);
        await cacheSet(cacheKey, { success: true, chits }, 120);
        res.status(200).json({ success: true, chits });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Start Chit Fund
// @route   POST /api/chitfunds/:id/start
// @access  Private
exports.startChitFund = async (req, res) => {
    try {
        const chit = await ChitFund.findById(req.params.id);
        if (chit.owner !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
        if (chit.currentSubscribersCount < chit.totalMonths) return res.status(400).json({ success: false, message: 'Group not full' });
        
        chit.status = 'active';
        chit.startDate = new Date();
        chit.activeAuctionMonth = 1;
        await chit.save();

        await cacheInvalidate(`chit:dashboard:${chit._id}`, `chit:managed:${req.user.id}`);
        res.status(200).json({ success: true, chit });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Submit a bid (Discount)
// @route   POST /api/chitfunds/:id/bid
// @access  Private
exports.submitBid = async (req, res) => {
    try {
        const { discountAmount } = req.body;
        const chit = await ChitFund.findById(req.params.id);
        if (chit.status !== 'active') return res.status(400).json({ success: false, message: 'Chit is not active' });
        
        const bid = await ChitBid.create({
            chitFund: chit._id,
            user: req.user.id,
            monthNumber: chit.activeAuctionMonth,
            discountAmount
        });

        res.status(200).json({ success: true, bid });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get all bids for active month
// @route   GET /api/chitfunds/:id/bids
// @access  Private (Owner)
exports.getBids = async (req, res) => {
    try {
        const chit = await ChitFund.findById(req.params.id);
        if (chit.owner !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
        
        const bids = await ChitBid.find({ chitFund: chit._id, monthNumber: chit.activeAuctionMonth }).sort({ discountAmount: -1 });
        res.status(200).json({ success: true, bids });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Declare Winner (The Math happens here)
// @route   POST /api/chitfunds/:id/declare-winner
// @access  Private (Owner)
const Money = require('../utils/money');
const LedgerEntry = require('../models/LedgerEntry');
const { withTransaction } = require('../utils/dbTransaction');

exports.declareWinner = async (req, res) => {
    try {
        const { winnerUserId, winningDiscount } = req.body;
        
        if (winningDiscount === undefined || winningDiscount === null) {
            return res.status(400).json({ success: false, message: 'Winning discount amount is required' });
        }

        const discountPaise = Money.toPaise(winningDiscount);
        if (discountPaise < 0) return res.status(400).json({ success: false, message: 'Discount cannot be negative' });

        const { auction, finalMonthlyInstallment, prizePayout } = await withTransaction(async (session) => {
            const chit = await ChitFund.findById(req.params.id).session(session);
            
            if (!chit) throw new Error('CHIT_NOT_FOUND');
            if (chit.owner !== req.user.id) throw new Error('UNAUTHORIZED');
            if (chit.status === 'completed') throw new Error('CHIT_ALREADY_COMPLETED');
            
            // --- ATOMIC CHIT MATH (Integers / Paise) ---
            const totalValuePaise = Money.toPaise(chit.totalValue);
            const totalMonths = chit.totalMonths;
            const commissionPaise = Math.floor((totalValuePaise * chit.commissionPercentage) / 100);
            
            // Dividend Pool = Discount - Organizer Commission
            const dividendPoolPaise = Math.max(0, discountPaise - commissionPaise);
            
            // Count active subscribers (usually equals totalMonths)
            const activeSubs = await ChitSubscription.find({ chitFund: chit._id, status: 'active' }).session(session);
            const membersCount = activeSubs.length || 1;
            
            const dividendShares = Money.allocate(dividendPoolPaise, membersCount);
            const dividendPerHeadPaise = dividendShares[0]; // Every member gets this share

            const baseMonthlyPaise = Math.floor(totalValuePaise / totalMonths);
            const netMonthlyPaise = Math.max(0, baseMonthlyPaise - dividendPerHeadPaise);
            
            const prizePayoutPaise = totalValuePaise - discountPaise;
            
            const auctionRecord = await ChitAuction.create([{
                chitFund: chit._id,
                monthNumber: chit.activeAuctionMonth,
                auctionDate: new Date(),
                winnerUserId,
                winningBidDiscount: Money.toRupees(discountPaise),
                dividendPerMember: Money.toRupees(dividendPerHeadPaise),
                prizeMoneyPaid: Money.toRupees(prizePayoutPaise)
            }], { session });
            
            const auction = auctionRecord[0];

            // Verify winner is subscribed and hasn't won already
            const winnerSub = activeSubs.find(s => s.user === winnerUserId);
            if (!winnerSub) throw new Error('WINNER_NOT_SUBSCRIBED');
            if (winnerSub.hasWonAuction) throw new Error('WINNER_ALREADY_WON');
            
            winnerSub.hasWonAuction = true;
            winnerSub.wonMonth = chit.activeAuctionMonth;
            
            // Apply dividends and payments records to all members atomically
            for (const sub of activeSubs) {
                sub.totalDividendEarned = (sub.totalDividendEarned || 0) + Money.toRupees(dividendPerHeadPaise);
                sub.paymentRecords.push({
                    monthNumber: chit.activeAuctionMonth,
                    isPaid: false
                });
                await sub.save({ session });
            }

            // Central Ledger Double-Entry Creation
            const txId = require('crypto').randomUUID();
            const idempotencyKeyStr = req.headers['x-idempotency-key'] || txId;

            // 1. Credit Organizer Commission
            await LedgerEntry.create([{
                transactionId: txId,
                account: 'SYSTEM:ORGANIZER_FEES',
                type: 'CREDIT',
                amountPaise: commissionPaise,
                referenceModel: 'ChitGroup',
                referenceId: chit._id,
                idempotencyKey: idempotencyKeyStr + '_COMMISSION',
                description: `Organizer commission for month ${chit.activeAuctionMonth}`
            }], { session });

            // 2. Credit Winner's Bank / Wallet with Prize Money
            await LedgerEntry.create([{
                transactionId: txId,
                account: 'USER:' + winnerUserId,
                type: 'CREDIT',
                amountPaise: prizePayoutPaise,
                referenceModel: 'ChitGroup',
                referenceId: chit._id,
                idempotencyKey: idempotencyKeyStr + '_PRIZE',
                description: `Chit winner payout for month ${chit.activeAuctionMonth}`
            }], { session });

            // Increment chit month
            chit.activeAuctionMonth += 1;
            if (chit.activeAuctionMonth > chit.totalMonths) {
                chit.status = 'completed';
            }
            await chit.save({ session });

            return { 
                auction, 
                finalMonthlyInstallment: Money.toRupees(netMonthlyPaise), 
                prizePayout: Money.toRupees(prizePayoutPaise) 
            };
        });

        // Cache invalidate outside transaction
        await cacheInvalidate(`chit:dashboard:${req.params.id}`);
        
        res.status(200).json({ success: true, auction, finalMonthlyInstallment, prizePayout });

    } catch (err) {
        const errorMapping = {
            'CHIT_NOT_FOUND': { status: 404, message: 'Chit fund not found' },
            'UNAUTHORIZED': { status: 403, message: 'Only owner can declare winner' },
            'CHIT_ALREADY_COMPLETED': { status: 400, message: 'Chit fund is already completed' },
            'WINNER_NOT_SUBSCRIBED': { status: 400, message: 'Selected winner is not an active subscriber' },
            'WINNER_ALREADY_WON': { status: 400, message: 'User has already won an auction in this chit fund' }
        };

        if (errorMapping[err.message]) {
            return res.status(errorMapping[err.message].status).json({ success: false, message: errorMapping[err.message].message });
        }
        console.error('[Chit] Declare Winner Error:', err.message);
        res.status(500).json({ success: false, message: 'Internal server error during settlement' });
    }
};// @desc    Get member detail (member's own view of a chit)
// @route   GET /api/chitfunds/:id/member-detail
// @access  Private
exports.getMemberDetail = async (req, res) => {
    try {
        const chitId = req.params.id;
        const userId = req.user.id;

        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit fund not found' });

        // Get subscription
        const subscription = await ChitSubscription.findOne({ chitFund: chitId, user: userId });
        if (!subscription) return res.status(404).json({ success: false, message: 'You are not a member of this chit' });

        // Get all subscriptions to determine slot number
        const allSubs = await ChitSubscription.find({ chitFund: chitId }).sort({ createdAt: 1 });
        const slotNumber = allSubs.findIndex(s => s.user === userId) + 1;

        // Get auction history
        const auctions = await ChitAuction.find({ chitFund: chitId }).sort({ monthNumber: 1 });
        const auctionHistory = await Promise.all(auctions.map(async (auction) => {
            let winnerName = 'Unknown';
            try {
                const winner = await User.findOne({ id: auction.winnerUserId });
                if (winner) winnerName = `${winner.firstName || ''} ${(winner.lastName || '')[0] || ''}.`.trim();
            } catch (e) {}
            return {
                month: auction.monthNumber,
                winnerName,
                winnerUserId: auction.winnerUserId,
                prizeAmount: chit.totalValue - (auction.winningBidDiscount || 0),
                bidDiscount: auction.winningBidDiscount || 0,
                dividendPerMember: auction.dividendPerMember || 0,
                date: auction.auctionDate,
            };
        }));

        // Calculate next due date (startDate + completedMonths + 1 month)
        let nextDueDate = null;
        if (chit.startDate) {
            const d = new Date(chit.startDate);
            d.setMonth(d.getMonth() + (chit.completedMonths || 0) + 1);
            nextDueDate = d.toISOString();
        }

        // Get payment history from ChitTransaction or construct from subscription data
        // We'll return a simple structure based on completed months
        const paymentHistory = [];
        for (let m = 1; m <= Math.max(chit.completedMonths || 0, 1); m++) {
            const monthAuction = auctions.find(a => a.monthNumber === m);
            const dividendForMonth = monthAuction ? (monthAuction.dividendPerMember || 0) : 0;
            const netPayable = chit.monthlySubscription - dividendForMonth;
            // Check if this subscriber has a payment record (use subscription.paymentRecords if exists)
            const paymentRecord = subscription.paymentRecords
                ? subscription.paymentRecords.find(p => p.monthNumber === m)
                : null;
            paymentHistory.push({
                month: m,
                monthLabel: chit.startDate ? _getMonthLabel(chit.startDate, m) : `Month ${m}`,
                status: paymentRecord ? (paymentRecord.isPaid ? 'paid' : 'pending') : (m <= (chit.completedMonths || 0) ? 'paid' : 'pending'),
                amount: Math.round(netPayable),
                dividendEarned: dividendForMonth,
            });
        }

        // Latest dividend
        const latestAuction = auctions[auctions.length - 1];
        const latestDividend = latestAuction ? (latestAuction.dividendPerMember || 0) : 0;

        res.status(200).json({
            success: true,
            chitInfo: {
                id: chit._id,
                name: chit.name,
                totalValue: chit.totalValue,
                totalMonths: chit.totalMonths,
                monthlySubscription: chit.monthlySubscription,
                status: chit.status,
                completedMonths: chit.completedMonths || 0,
                startDate: chit.startDate,
                branchName: chit.branchName,
            },
            subscription: {
                slotNumber,
                monthlyEmi: chit.monthlySubscription,
                nextDueDate,
                dividendEarnedThisMonth: latestDividend,
                totalPrizePot: chit.totalValue,
                hasWonAuction: subscription.hasWonAuction || false,
                wonMonth: subscription.wonMonth || null,
                totalMembers: chit.totalMonths,
            },
            auctionHistory,
            paymentHistory,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

function _getMonthLabel(startDate, monthNumber) {
    const d = new Date(startDate);
    d.setMonth(d.getMonth() + monthNumber - 1);
    return d.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
}

// @desc    Open auction for a month (admin action, sends FCM)
// @route   POST /api/chitfunds/:id/open-auction-month
// @access  Private (Owner)
exports.openAuctionMonth = async (req, res) => {
    try {
        const { monthNumber, baseAmount } = req.body;
        const chit = await ChitFund.findById(req.params.id);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit fund not found' });
        if (chit.owner !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
        if (chit.status !== 'active') return res.status(400).json({ success: false, message: 'Chit must be active to open auction' });

        chit.activeAuctionMonth = monthNumber;
        chit.activeAuctionBaseAmount = baseAmount || chit.totalValue;
        await chit.save();

        // Get all subscribers to send FCM
        const subscriptions = await ChitSubscription.find({ chitFund: chit._id, status: 'active' });
        const userIds = subscriptions.map(s => s.user);
        const users = await User.find({ id: { $in: userIds } });

        // Insert into NotificationOutbox
        if (users.length > 0) {
            const NotificationOutbox = require('../models/NotificationOutbox');
            const outboxEntries = users.map(u => ({
                aggregateType: 'CHIT',
                aggregateId: chit._id.toString(),
                eventType: 'CHIT_AUCTION_START',
                recipientUserId: u._id,
                channel: 'PUSH',
                payload: {
                    title: `🔴 Live Auction Started! - ${chit.name}`,
                    body: `Month ${monthNumber} auction is now LIVE. Bid now to win ₹${chit.totalValue.toLocaleString('en-IN')}!`,
                    chitId: chit._id.toString(),
                    monthNumber: String(monthNumber)
                }
            }));
            await NotificationOutbox.insertMany(outboxEntries);
        }

        await cacheInvalidate(`chit:dashboard:${chit._id}`);
        res.status(200).json({ success: true, message: 'Auction opened and members notified', chit });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Verify / Mark payment for a subscriber (Owner action)
// @route   POST /api/chitfunds/:id/verify-payment
// @access  Private (Owner)
exports.verifyMonthPayment = async (req, res) => {
    try {
        const { monthNumber, subscriberId, isPaid } = req.body;
        const chit = await ChitFund.findById(req.params.id);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit fund not found' });
        if (chit.owner !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });

        const subscription = await ChitSubscription.findOne({ chitFund: chit._id, user: subscriberId });
        if (!subscription) return res.status(404).json({ success: false, message: 'Subscriber not found' });

        // Update payment record
        if (!subscription.paymentRecords) subscription.paymentRecords = [];
        const existingRecord = subscription.paymentRecords.find(p => p.monthNumber === monthNumber);
        if (existingRecord) {
            existingRecord.isPaid = isPaid;
            existingRecord.markedAt = new Date();
        } else {
            subscription.paymentRecords.push({
                monthNumber,
                isPaid,
                markedAt: new Date(),
            });
        }
        subscription.markModified('paymentRecords');
        await subscription.save();

        // Create notification for the subscriber if marked paid
        if (isPaid) {
            await Notification.create({
                userId: subscriberId,
                title: 'Payment Confirmed ✅',
                body: `Your Month ${monthNumber} payment for ${chit.name} has been confirmed by the admin.`,
                type: 'PAYMENT_CONFIRMED',
                data: { chitId: chit._id.toString(), monthNumber: String(monthNumber) },
            }).catch(() => {}); // non-critical
        }

        await cacheInvalidate(`chit:dashboard:${req.params.id}`);
        res.status(200).json({ success: true, message: `Payment ${isPaid ? 'marked as paid' : 'marked as unpaid'}` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get full admin dashboard for a chit group
// @route   GET /api/chitfunds/:id
// @access  Private
const AuthorizationService = require('../services/AuthorizationService');
const { parsePagination } = require('../utils/pagination');
const BidService = require('../services/BidService');

exports.getChitDashboard = async (req, res) => {
    try {
        const chitId = req.params.id;
        const userId = req.user.id;
        
        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit fund not found' });

        const isOwner = AuthorizationService.canManageChit(userId, chit);
        const isMember = await AuthorizationService.canViewChit(userId, chitId);
        
        if (!isOwner && !isMember) {
            return res.status(403).json({ success: false, message: 'Unauthorized access to Chit dashboard' });
        }

        const cacheKey = `chit:dashboard:${chitId}:${userId}`; // Cache partitioned by user
        const cached = await cacheGet(cacheKey);
        if (cached) return res.status(200).json(cached);

        const subscriptions = await ChitSubscription.find({ chitFund: chitId });
        const auctions = await ChitAuction.find({ groupId: chitId }).sort({ cycleIndex: 1 });

        // DTO Mapping: Remove sensitive PII unless viewed by owner
        const ChitMemberSummary = await Promise.all(subscriptions.map(async (sub, index) => {
            const user = await User.findOne({ id: sub.user });
            const paymentRecords = sub.paymentRecords || [];
            const paidMonths = paymentRecords.filter(p => p.isPaid).map(p => p.monthNumber);
            
            // Mask phone numbers for non-owners
            let phoneDisplay = '';
            if (user && user.phone) {
                phoneDisplay = isOwner || sub.user === userId ? user.phone : '******' + String(user.phone).slice(-4);
            }

            return {
                id: sub.user,
                slotNumber: index + 1,
                user: {
                    id: sub.user,
                    firstName: user ? user.firstName : 'Member',
                    lastName: user ? (user.lastName ? user.lastName[0] + '.' : '') : '',
                    phone: phoneDisplay,
                },
                status: sub.status,
                hasWonAuction: sub.hasWonAuction || false,
                wonMonth: sub.wonMonth || null,
                installmentsPaid: sub.installmentsPaid || paidMonths.length,
                totalDividendEarned: sub.totalDividendEarned || 0,
            };
        }));

        const responseDTO = {
            success: true,
            chit: {
                id: chit._id,
                name: chit.name,
                totalValue: chit.totalValue,
                totalMonths: chit.totalMonths,
                monthlySubscription: chit.monthlySubscription,
                status: chit.status,
                activeAuctionMonth: chit.activeAuctionMonth,
                isOwner: isOwner
            },
            members: ChitMemberSummary,
            auctions: auctions.map(a => ({
                cycleIndex: a.cycleIndex,
                status: a.status,
                winningBid: a.currentLowestBid ? Money.toRupees(a.currentLowestBid) : null,
                winnerUser: a.currentWinner,
                endTime: a.endTime
            }))
        };

        await cacheSet(cacheKey, responseDTO, 60); // 1 minute cache
        res.status(200).json(responseDTO);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.submitBid = async (req, res) => {
    try {
        const { discountAmount } = req.body;
        const chit = await ChitFund.findById(req.params.id);
        
        if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });
        if (chit.status !== 'active') return res.status(400).json({ success: false, message: 'Chit is not active' });
        
        // Find the active auction for this chit
        const auction = await ChitAuction.findOne({ groupId: chit._id, status: 'open' });
        if (!auction) return res.status(400).json({ success: false, message: 'No open auction found for this chit' });

        const bidDiscountPaise = Money.toPaise(discountAmount);
        
        // Delegate completely to domain service
        const result = await BidService.placeBid({
            auctionId: auction._id,
            userId: req.user.id,
            bidDiscountPaise: bidDiscountPaise,
            idempotencyKey: req.headers['x-idempotency-key']
        });

        res.status(200).json(result);
    } catch (err) {
        if (err.message.includes('UNAUTHORIZED')) return res.status(403).json({ success: false, message: err.message });
        res.status(500).json({ success: false, message: err.message });
    }
};exports.deleteChitFund = async (req, res) => {
    try {
        const chit = await ChitFund.findById(req.params.id);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit fund not found' });
        if (chit.owner !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
        if (chit.status === 'active') {
            return res.status(400).json({ success: false, message: 'Cannot delete an active chit fund. Close it first.' });
        }

        // Remove associated subscriptions and invites
        await ChitSubscription.deleteMany({ chitFund: chit._id });
        await ChitInvite.deleteMany({ chitFund: chit._id });
        await chit.deleteOne();

        res.status(200).json({ success: true, message: 'Chit fund deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};




exports.declineInvite = async (req, res) => {
    // Basic stub to resolve undefined callback crash
    res.status(200).json({ success: true, message: 'Invite declined.' });
};
