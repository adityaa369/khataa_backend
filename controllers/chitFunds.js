const ChitFund = require('../models/ChitFund');
const ChitSubscription = require('../models/ChitSubscription');
const ChitInvite = require('../models/ChitInvite');
const ChitAuction = require('../models/ChitAuction');
const ChitBid = require('../models/ChitBid');
const User = require('../models/User');
const Notification = require('../models/Notification');

// @desc    Create a new Chit Fund Group
// @route   POST /api/chitfunds
// @access  Private
exports.createChitFund = async (req, res) => {
    try {
        const { name, totalValue, totalMonths, monthlySubscription, commissionPercentage } = req.body;
        
        const chit = await ChitFund.create({
            name,
            totalValue,
            totalMonths,
            monthlySubscription,
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
        const chits = await ChitFund.find({ owner: req.user.id });
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
        const subscriptions = await ChitSubscription.find({ user: req.user.id }).populate('chitFund');
        const chits = subscriptions.map(sub => sub.chitFund);
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

        res.status(200).json({ success: true, auction, finalMonthlyInstallment, prizePayout });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
