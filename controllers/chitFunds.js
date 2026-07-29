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
exports.declareWinner = async (req, res) => {
    try {
        const { winnerUserId, winningDiscount } = req.body;
        const chit = await ChitFund.findById(req.params.id);
        if (chit.owner !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });
        
        // --- CHIT MATH ---
        const P = chit.totalValue;
        const M = chit.totalMonths;
        const D = winningDiscount;
        const C = P * 0.05; // 5% Commission
        
        const netDividend = (D - C) / M;
        const finalMonthlyInstallment = chit.monthlySubscription - netDividend;
        const prizePayout = P - D;
        
        const auction = await ChitAuction.create({
            chitFund: chit._id,
            monthNumber: chit.activeAuctionMonth,
            auctionDate: new Date(),
            winnerUserId,
            winningBidDiscount: D,
            dividendPerMember: netDividend,
            prizeMoneyPaid: prizePayout
        });

        // Mark winner
        const sub = await ChitSubscription.findOne({ chitFund: chit._id, user: winnerUserId });
        if (sub) {
            sub.hasWonAuction = true;
            sub.wonMonth = chit.activeAuctionMonth;
            await sub.save();
        }

        chit.activeAuctionMonth += 1;
        if (chit.activeAuctionMonth > chit.totalMonths) {
            chit.status = 'completed';
        }
        await chit.save();

        await cacheInvalidate(`chit:dashboard:${chit._id}`);
        res.status(200).json({ success: true, auction, finalMonthlyInstallment, prizePayout });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get member detail (member's own view of a chit)
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
        const users = await User.find({ id: { $in: userIds }, fcmToken: { $exists: true, $ne: null } });

        // Send FCM notifications (fire and forget)
        if (users.length > 0) {
            const admin = require('../config/firebase');
            const tokens = users.map(u => u.fcmToken).filter(Boolean);
            if (tokens.length > 0) {
                try {
                    await admin.messaging().sendEachForMulticast({
                        tokens,
                        notification: {
                            title: `🔴 Live Auction Started! - ${chit.name}`,
                            body: `Month ${monthNumber} auction is now LIVE. Bid now to win ₹${chit.totalValue.toLocaleString('en-IN')}!`,
                        },
                        data: {
                            type: 'CHIT_AUCTION_START',
                            chitId: chit._id.toString(),
                            monthNumber: String(monthNumber),
                        },
                    });
                } catch (fcmErr) {
                    console.error('[FCM] Auction start notification failed:', fcmErr.message);
                }
            }
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
exports.getChitDashboard = async (req, res) => {
    try {
        const chitId = req.params.id;
        const cacheKey = `chit:dashboard:${chitId}`;
        const cached = await cacheGet(cacheKey);
        if (cached) return res.status(200).json(cached);

        const userId = req.user.id;
        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit fund not found' });

        const isOwner = chit.owner === userId;
        const subscriptions = await ChitSubscription.find({ chitFund: chitId });
        const auctions = await ChitAuction.find({ chitFund: chitId }).sort({ monthNumber: 1 });

        // Enrich member data — match the exact shape the Flutter admin page reads
        const members = await Promise.all(subscriptions.map(async (sub, index) => {
            const user = await User.findOne({ id: sub.user });
            const paymentRecords = sub.paymentRecords || [];
            // Build paidMonths array for the Flutter page (it reads member['paidMonths'])
            const paidMonths = paymentRecords.filter(p => p.isPaid).map(p => p.monthNumber);
            return {
                id: sub.user,
                slotNumber: index + 1,
                user: {
                    id: sub.user,
                    firstName: user ? user.firstName : '',
                    lastName: user ? user.lastName : '',
                    phone: user ? user.phone : '',
                },
                status: sub.status,
                hasWonAuction: sub.hasWonAuction || false,
                wonMonth: sub.wonMonth || null,
                paymentRecords,
                paidMonths,
                installmentsPaid: sub.installmentsPaid || paidMonths.length,
                totalDividendEarned: sub.totalDividendEarned || 0,
            };
        }));

        // Auction timeline shape for Flutter page (reads auctionTimeline)
        const auctionTimeline = await Promise.all(auctions.map(async (auction) => {
            let winnerName = '';
            try {
                const winner = await User.findOne({ id: auction.winnerUserId });
                if (winner) winnerName = `${winner.firstName || ''} ${winner.lastName || ''}`.trim();
            } catch (e) {}
            return {
                monthNumber: auction.monthNumber,
                auctionDate: auction.auctionDate,
                winnerUserId: auction.winnerUserId,
                winnerName,
                winningBidDiscount: auction.winningBidDiscount || 0,
                prizeMoneyPaid: auction.prizeMoneyPaid || (chit.totalValue - (auction.winningBidDiscount || 0)),
                dividendPerMember: auction.dividendPerMember || 0,
            };
        }));

        // chitDetails shape for Flutter page
        const chitDetails = {
            id: chit._id.toString(),
            name: chit.name,
            totalValue: chit.totalValue,
            totalMonths: chit.totalMonths,
            monthlySubscription: chit.monthlySubscription,
            commissionPercentage: chit.commissionPercentage || 5,
            branchName: chit.branchName,
            status: chit.status,
            currentSubscribersCount: chit.currentSubscribersCount,
            completedMonths: chit.completedMonths || 0,
            activeAuctionMonth: chit.activeAuctionMonth || null,
            startDate: chit.startDate,
            owner: chit.owner,
            isOwner,
        };

        const responseData = {
            success: true,
            chitDetails,
            members,
            auctionTimeline,
            currentMonth: chit.activeAuctionMonth || (chit.completedMonths || 0) + 1,
            completedMonths: chit.completedMonths || 0,
            isOwner,
        };
        await cacheSet(cacheKey, responseData, 60);
        return res.status(200).json(responseData);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Decline an invite
// @route   POST /api/chitfunds/invites/:inviteId/decline
// @access  Private
exports.declineInvite = async (req, res) => {
    try {
        const invite = await ChitInvite.findById(req.params.inviteId);
        if (!invite) return res.status(404).json({ success: false, message: 'Invite not found' });
        invite.status = 'declined';
        await invite.save();
        res.status(200).json({ success: true, message: 'Invite declined' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Delete / cancel a chit fund (owner only, only if not yet started)
// @route   DELETE /api/chitfunds/:id
// @access  Private (Owner)
exports.deleteChitFund = async (req, res) => {
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
