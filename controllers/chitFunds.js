const ChitFund = require('../models/ChitFund');
const ChitSubscription = require('../models/ChitSubscription');
const ChitAuction = require('../models/ChitAuction');
const ChitInvite = require('../models/ChitInvite');
const User = require('../models/User');

// @desc    Get members of a specific Chit Fund
// @route   GET /api/chits/:id/members
// @access  Private
exports.getChitMembers = async (req, res) => {
    try {
        const chitId = req.params.id;
        
        // 1. Verify Chit Exists
        const chit = await ChitFund.findById(chitId);
        if (!chit) {
            return res.status(404).json({ success: false, message: 'Chit not found' });
        }

        // 2. Fetch active members (Subscribers)
        let subscriptions = await ChitSubscription.find({ chitFund: chitId }).lean();
        
        // Populate actual user data from User model
        let members = [];
        for (let sub of subscriptions) {
            const userDoc = await User.findOne({ id: sub.user }).select('firstName lastName phone profilePic').lean();
            if (userDoc) {
                members.push({
                    user: userDoc,
                    installmentsPaid: sub.installmentsPaid,
                    hasWonAuction: sub.hasWonAuction,
                    wonMonth: sub.wonMonth,
                    totalDividendEarned: sub.totalDividendEarned,
                    status: sub.status,
                    joinedAt: sub.createdAt
                });
            }
        }

        // 3. Fetch pending invites (useful for Organizer view Tracker)
        let pendingInvites = [];
        if (chit.owner.toString() === req.user.id) {
            let invites = await ChitInvite.find({ chitFund: chitId, status: 'pending' }).lean();
            for (let inv of invites) {
               let inviteeInfo = null;
               if (inv.receiverId) {
                   inviteeInfo = await User.findOne({ id: inv.receiverId }).select('firstName lastName phone profilePic').lean();
               }
               pendingInvites.push({
                   phone: inv.receiverPhone,
                   user: inviteeInfo,
                   status: inv.status,
                   sentAt: inv.createdAt
               });
            }
        }

        res.status(200).json({ 
            success: true, 
            chitDetails: {
              name: chit.name,
              totalMonths: chit.totalMonths,
              currentSubscribersCount: chit.currentSubscribersCount,
              status: chit.status,
              isOwner: chit.owner.toString() === req.user.id
            },
            members, 
            pendingInvites 
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Create a new Chit Fund (Dynamic config by Owner)
// @route   POST /api/chits/create
// @access  Private
exports.createChitFund = async (req, res) => {
    try {
        const { name, totalValue, totalMonths, branchName } = req.body;

        if (!name || !totalValue || !totalMonths) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        const monthlySubscription = totalValue / totalMonths;

        const chit = await ChitFund.create({
            name,
            totalValue,
            totalMonths,
            monthlySubscription,
            branchName: branchName || 'HEAD-OFFICE',
            owner: req.user.id,
            status: 'registration',
            currentSubscribersCount: 0
        });

        res.status(201).json({ success: true, chit });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: 'Chit name already exists' });
        }
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get all owned chits (registration, active, completed)
// @route   GET /api/chits/vacant
// @access  Private
exports.getVacantChits = async (req, res) => {
    try {
        // Fetch all chits owned by this user
        const chits = await ChitFund.find({ owner: req.user.id });
        res.status(200).json({ success: true, chits });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Join a vacant chit
// @route   POST /api/chits/:id/join
// @access  Private
exports.joinChit = async (req, res) => {
    try {
        const chit = await ChitFund.findById(req.params.id);

        if (!chit) {
            return res.status(404).json({ success: false, message: 'Chit fund not found' });
        }

        if (chit.status !== 'registration') {
            return res.status(400).json({ success: false, message: 'Chit fund is closed for new registrations' });
        }

        // Check capacity
        if (chit.currentSubscribersCount >= chit.totalMonths) {
             return res.status(400).json({ success: false, message: 'This chit group is fully subscribed' });
        }

        // Create subscription
        const sub = await ChitSubscription.create({
            user: req.user.id,
            chitFund: chit._id
        });

        // Increment subscribers count
        chit.currentSubscribersCount += 1;
        
        // Auto-start chit if full
        if (chit.currentSubscribersCount === chit.totalMonths) {
            chit.status = 'active';
            chit.startDate = new Date();
        }
        await chit.save();

        res.status(201).json({ success: true, message: 'Successfully joined chit fund', subscription: sub });
    } catch (err) {
        // Handle unique constraint failure
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: 'You have already joined this chit fund' });
        }
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get current user's active chit subscriptions
// @route   GET /api/chits/my
// @access  Private
exports.getMyChits = async (req, res) => {
    try {
        const subs = await ChitSubscription.find({ user: req.user.id })
            .populate('chitFund');
        
        // Format for frontend
        const result = await Promise.all(subs.map(async (sub) => {
            const chit = sub.chitFund;
            
            // Accurate Mathematics: Base monthly installment is simply Total Value / Total Months
            let dueAmount = chit.totalValue / chit.totalMonths;

            
            // Calculate dividend from previous month (if applicable)
            if (chit.completedMonths > 0) {
                const ChitAuction = require('../models/ChitAuction');
                const lastAuction = await ChitAuction.findOne({ chitFund: chit._id, monthNumber: chit.completedMonths });
                if (lastAuction && lastAuction.dividendPerMember) {
                    dueAmount -= lastAuction.dividendPerMember; // Subtract the reward from their monthly due!
                }
            }

            // Zero out dues if they've paid for the current active month or are completed
            if (sub.installmentsPaid > chit.completedMonths || chit.status === 'completed') {
                dueAmount = 0;
            }

            return {
                id: sub._id,
                chitId: chit._id,
                chitName: chit.name,
                branchName: chit.branchName,
                totalValue: chit.totalValue,
                totalMonths: chit.totalMonths,
                completedMonths: chit.completedMonths,
                installmentsPaid: sub.installmentsPaid,
                dueAmount: Math.max(0, dueAmount), // Ensure it doesn't go below 0
                status: sub.status
            };
        }));

        res.status(200).json({ success: true, myChits: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get active auctions to authorize bid
// @route   GET /api/chits/auctions/pending
// @access  Private
exports.getPendingAuctions = async (req, res) => {
    try {
        // For MVP, just return the active chits the user is part of that haven't won yet
        const subs = await ChitSubscription.find({ user: req.user.id, hasWonAuction: false, status: 'active' })
            .populate('chitFund');

        const auctions = subs.map(sub => {
            const chit = sub.chitFund;
            return {
                chitId: chit._id,
                chitName: chit.name,
                branchName: chit.branchName,
                totalValue: chit.totalValue,
                // Mock next auction date to 5 days from now
                auctionDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) 
            };
        });

        res.status(200).json({ success: true, auctions });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Authorize a bid for a chit fund (with validations)
// @route   POST /api/chits/auctions/:id/authorize
// @access  Private
exports.authorizeBid = async (req, res) => {
    try {
        const chitId = req.params.id;
        const { bidDiscount } = req.body;
        
        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });

        if (chit.status !== 'active') {
             return res.status(400).json({ success: false, message: 'Chit fund is not active (Group might not be fully formed yet)' });
        }

        // Validation 1: Bid Cap (Max 40% of Total Value)
        const maxBidAllowed = chit.totalValue * 0.40;
        if (bidDiscount > maxBidAllowed) {
            return res.status(400).json({ success: false, message: `Bid discount exceeds maximum allowed cap of 40% (₹${maxBidAllowed})` });
        }

        const sub = await ChitSubscription.findOne({ user: req.user.id, chitFund: chitId });
        if (!sub) {
            return res.status(404).json({ success: false, message: 'You are not subscribed to this chit fund' });
        }

        // Validation 2: Eligibility Check (No pending dues)
        if (sub.status === 'defaulted' || sub.installmentsPaid < chit.completedMonths) {
             return res.status(403).json({ success: false, message: 'Ineligible to bid: You have pending installments' });
        }

        // Validation 3: Winner Restriction
        if (sub.hasWonAuction) {
            return res.status(403).json({ success: false, message: 'Ineligible to bid: You have already won a previous auction in this group' });
        }

        // In a real app, this bid would be pushed to an array of active bids for the current month's auction cycle.
        // For MVP, we directly record the auction if valid. In reality, multiple people bid and cron job picks the highest.
        // As a quick safe simplification for Phase 3:
        const ChitAuction = require('../models/ChitAuction');
        
        let auction = await ChitAuction.findOne({ chitFund: chitId, monthNumber: chit.completedMonths + 1 });
        if (!auction) {
            // First person to bid sets the baseline
            auction = await ChitAuction.create({
                chitFund: chitId,
                monthNumber: chit.completedMonths + 1,
                auctionDate: new Date(),
                winnerUserId: req.user.id,
                winningBidDiscount: bidDiscount,
                dividendPerMember: 0,
                prizeMoneyPaid: 0
            });
        } else {
            // If this new bid is higher, they steal the winning spot!
            if (bidDiscount > auction.winningBidDiscount) {
                auction.winnerUserId = req.user.id;
                auction.winningBidDiscount = bidDiscount;
                await auction.save();
            }
        }

        res.status(200).json({ success: true, message: 'Bid authorized and submitted successfully', currentHighestBid: auction.winningBidDiscount });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Finalize Auction for the current month
// @route   POST /api/chits/:id/finalize-auction
// @access  Private (Organizer Only)
exports.finalizeAuction = async (req, res) => {
    try {
        const chitId = req.params.id;
        const chit = await ChitFund.findById(chitId);

        if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });
        if (chit.owner.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Only standard owner can finalize' });

        const ChitAuction = require('../models/ChitAuction');
        const targetMonth = chit.completedMonths + 1;

        const { winnerUserId, bidDiscount } = req.body;
        
        let auction = await ChitAuction.findOne({ chitFund: chitId, monthNumber: targetMonth });
        
        // Manual Finalize bypass: If Owner inputs explicitly via Dashboard, create/overwrite it
        if (winnerUserId && typeof bidDiscount === 'number') {
            if (bidDiscount > (chit.totalValue * 0.40)) {
                 return res.status(400).json({ success: false, message: 'Bid exceeds maximum 40% cap' });
            }
            if (!auction) {
                 auction = await ChitAuction.create({
                     chitFund: chitId,
                     monthNumber: targetMonth,
                     auctionDate: new Date(),
                     winnerUserId: winnerUserId,
                     winningBidDiscount: bidDiscount,
                     dividendPerMember: 0,
                     prizeMoneyPaid: 0
                 });
            } else {
                 auction.winnerUserId = winnerUserId;
                 auction.winningBidDiscount = bidDiscount;
            }
        }
        
        if (!auction) return res.status(400).json({ success: false, message: 'No bids exist for this month yet. Provide a winner manually.' });
        const dividendPool = auction.winningBidDiscount;
        
        // Members get the dividend
        auction.dividendPerMember = dividendPool > 0 ? (dividendPool / chit.totalMonths) : 0;
        
        // Winner gets the pot
        auction.prizeMoneyPaid = chit.totalValue - auction.winningBidDiscount;
        await auction.save();

        // Mark the individual subscriber as having won!
        const winnerSub = await ChitSubscription.findOne({ user: auction.winnerUserId, chitFund: chitId });
        if (winnerSub) {
            winnerSub.hasWonAuction = true;
            winnerSub.wonMonth = targetMonth;
            await winnerSub.save();
        }

        // Advance the chit!
        chit.completedMonths += 1;
        if (chit.completedMonths >= chit.totalMonths) {
            chit.status = 'completed';
        }
        await chit.save();

        // Broadcast notification to all active subscribers
        const subscribers = await ChitSubscription.find({ chitFund: chitId });
        const { sendPushNotification } = require('../utils/fcm');
        const winnerDoc = await User.findOne({ id: auction.winnerUserId }).select('firstName lastName').lean();
        
        for (let sub of subscribers) {
            const memberUser = await User.findOne({ id: sub.user });
            if (memberUser && memberUser.fcmToken) {
                await sendPushNotification(
                    memberUser.fcmToken,
                    'Chit Auction Finalized',
                    `${winnerDoc ? winnerDoc.firstName : 'A member'} won! Auction for month ${targetMonth} is complete. Winner discount: ₹${auction.winningBidDiscount}. Your dividend: ₹${auction.dividendPerMember.toFixed(2)}.`,
                    { type: 'AUCTION_FINALIZED', chitId: chit._id.toString() }
                );
            }
        }

        res.status(200).json({ success: true, message: 'Auction finalized successfully', auction });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Pay monthly installment for a Chit Fund
// @route   POST /api/chits/:id/installments
// @access  Private
exports.payInstallment = async (req, res) => {
    try {
        const { transactionId, amountPaid, monthNumber } = req.body;
        
        if (!transactionId) {
            return res.status(400).json({ success: false, message: 'A valid transaction ID must be provided to generate a receipt' });
        }

        const sub = await ChitSubscription.findOne({ user: req.user.id, chitFund: req.params.id });
        if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });

        // Instead of actively storing everything loosely in arrays, we ideally push to a ChitTransaction model.
        // For now, retaining backward compatibility with the array until model is established:
        sub.transactions.push({
            monthNumber,
            amountPaid,
            transactionId,
            date: new Date()
        });

        // The user has simply submitted their receipt. It goes to pending.
        const msg = req.user.id === chit.owner.toString() 
                    ? 'Payment verified automatically for the organizer' 
                    : 'Installment submitted. Waiting for organizer verification.';
        
        // Auto-verify if the caller is the Organizer
        if (req.user.id === chit.owner.toString()) {
            sub.installmentsPaid += 1;
            // Check if user is now up to date
            if (sub.installmentsPaid >= chit.completedMonths && sub.status === 'defaulted') {
                 sub.status = 'active'; // Restore eligibility
            }
        }

        await sub.save();

        res.status(200).json({ success: true, message: msg, receipt: transactionId });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Verify a member's monthly installment payment
// @route   POST /api/chits/:id/verify-installment
// @access  Private (Organizer Only)
exports.verifyInstallment = async (req, res) => {
    try {
        const chitId = req.params.id;
        const { subscriberId, transactionId } = req.body;

        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });

        if (chit.owner.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only the group owner can verify payments' });
        }

        const sub = await ChitSubscription.findById(subscriberId);
        if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });

        // Safely bump installments
        sub.installmentsPaid += 1;

        if (sub.installmentsPaid >= chit.completedMonths && sub.status === 'defaulted') {
            sub.status = 'active'; 
        }

        await sub.save();
        res.status(200).json({ success: true, message: 'Member payment verified successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Send an invite to a user via Phone Number
// @route   POST /api/chits/:id/invite
// @access  Private (Owner Only)
exports.sendInvite = async (req, res) => {
    try {
        const chitId = req.params.id;
        const { receiverPhone } = req.body;

        if (!receiverPhone) {
            return res.status(400).json({ success: false, message: 'Please provide a receiver phone number' });
        }

        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });

        if (chit.owner.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only the group owner can send invites' });
        }

        if (chit.status !== 'registration') {
            return res.status(400).json({ success: false, message: 'Cannot invite to an active or completed chit' });
        }

        // Check if user exists in our system
        const receiver = await User.findOne({ phone: receiverPhone });

        const invite = await ChitInvite.create({
            chitFund: chitId,
            sender: req.user.id,
            receiverPhone,
            receiverId: receiver ? receiver.id : null
        });

        // Fire FCM Notification to Invitee
        if (receiver && receiver.fcmToken) {
            const { sendPushNotification } = require('../utils/fcm');
            await sendPushNotification(
                receiver.fcmToken,
                'Chit Group Invitation',
                `${req.user.firstName || 'Someone'} has invited you to join the ${chit.name} Chit Group.`,
                { type: 'CHIT_INVITE', chitId: chit._id.toString() }
            );
        }

        res.status(201).json({ success: true, message: 'Invite sent successfully', invite });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: 'An invite to this phone number already exists for this chit' });
        }
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get user's pending invites
// @route   GET /api/chits/invites
// @access  Private
exports.getMyInvites = async (req, res) => {
    try {
        let invites = await ChitInvite.find({ 
            $or: [
                { receiverId: req.user.id },
                { receiverPhone: req.user.phone } // Match by phone if ID wasn't linked initially
            ],
            status: 'pending'
        }).populate('chitFund').lean();

        for (let inv of invites) {
            const senderUser = await User.findOne({ id: inv.sender }).select('firstName lastName phone').lean();
            inv.sender = senderUser;
        }

        res.status(200).json({ success: true, count: invites.length, data: invites });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Respond to an invite (accept/decline)
// @route   POST /api/chits/invites/:id/respond
// @access  Private
exports.respondToInvite = async (req, res) => {
    try {
        const { status } = req.body; // 'accepted' or 'declined'
        const inviteId = req.params.id;

        if (!['accepted', 'declined'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid response status' });
        }

        const invite = await ChitInvite.findById(inviteId);
        if (!invite) return res.status(404).json({ success: false, message: 'Invite not found' });

        // Link ID if it wasn't already (e.g. they registered after invite was sent)
        if (!invite.receiverId) {
            invite.receiverId = req.user.id;
        }

        // Verify it belongs to them
        if (invite.receiverId.toString() !== req.user.id && invite.receiverPhone !== req.user.phone) {
            return res.status(403).json({ success: false, message: 'Not authorized to respond to this invite' });
        }

        if (invite.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Invite has already been ${invite.status}` });
        }

        invite.status = status;
        await invite.save();

        if (status === 'accepted') {
            const chit = await ChitFund.findById(invite.chitFund);
            
            if (chit.currentSubscribersCount >= chit.totalMonths) {
                 return res.status(400).json({ success: false, message: 'This chit group is already fully subscribed' });
            }

            // Create subscription
            const sub = await ChitSubscription.create({
                user: req.user.id,
                chitFund: chit._id
            });

            // Increment count & auto-start check
            chit.currentSubscribersCount += 1;
            if (chit.currentSubscribersCount === chit.totalMonths) {
                chit.status = 'active';
                chit.startDate = new Date();
                
                // Clear any remaining pending invites for this fully-subscribed chit
                await ChitInvite.updateMany(
                    { chitFund: chit._id, status: 'pending' },
                    { $set: { status: 'declined' } }
                );
            }
            await chit.save();

            // Fire FCM Notification to Group Owner
            const owner = await User.findOne({ id: chit.owner });
            if (owner && owner.fcmToken) {
                const { sendPushNotification } = require('../utils/fcm');
                await sendPushNotification(
                    owner.fcmToken,
                    'Chit Group Update',
                    `${req.user.firstName || 'A user'} has joined your Chit Group ${chit.name}.`,
                    { type: 'CHIT_JOINED', chitId: chit._id.toString() }
                );
            }

            return res.status(200).json({ success: true, message: 'Invite accepted. You joined the chit fund.', subscription: sub });
        }

        res.status(200).json({ success: true, message: 'Invite declined' });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get Owner Admin Dashboard Data (Members Matrix & Auction Timeline)
// @route   GET /api/chits/:id/admin-dashboard
// @access  Private (Owner Only)
exports.getAdminDashboard = async (req, res) => {
    try {
        const chitId = req.params.id;
        const chit = await ChitFund.findById(chitId).lean();

        if (!chit) {
            return res.status(404).json({ success: false, message: 'Chit not found' });
        }


        // 1. Fetch Members & Payment Tracking
        let subscriptions = await ChitSubscription.find({ chitFund: chitId }).lean();
        
        let members = [];
        let ownerFound = false;

        for (let sub of subscriptions) {
            if (sub.user === chit.owner.toString()) ownerFound = true;

            const userDoc = await User.findOne({ id: sub.user }).select('id firstName lastName phone profilePic').lean();
            if (userDoc) {
                // Map transactions to exact months they paid for
                let paidMonths = sub.transactions ? sub.transactions.map(t => t.monthNumber) : [];
                let installmentsPaidCount = sub.installmentsPaid || 0;
                
                // Privacy Check: Only owner or the exact member themselves can see their payment statuses
                if (chit.owner.toString() !== req.user.id && sub.user !== req.user.id) {
                    paidMonths = [];
                    installmentsPaidCount = 0;
                }
                
                members.push({
                    id: sub._id,
                    user: userDoc,
                    installmentsPaidCount: installmentsPaidCount,
                    paidMonths: paidMonths, // e.g. [1, 2] means paid for month 1 and 2
                    hasWonAuction: sub.hasWonAuction,
                    wonMonth: sub.wonMonth,
                    status: sub.status,
                    joinedAt: sub.createdAt
                });
            }
        }

        // Auto-inject owner if missing (backward compatibility for old chit groups)
        if (!ownerFound) {
            const ownerDoc = await User.findOne({ id: chit.owner.toString() }).select('id firstName lastName phone profilePic').lean();
            if (ownerDoc) {
                members.unshift({
                    id: 'synthetic_owner_sub',
                    user: ownerDoc,
                    installmentsPaidCount: chit.completedMonths || 0,
                    paidMonths: [], // Owner doesn't strictly pay themselves, or we don't track it here
                    hasWonAuction: false,
                    status: 'active',
                    joinedAt: chit.createdAt
                });
            }
        }

        // 2. Fetch Auction Timeline
        const ChitAuction = require('../models/ChitAuction');
        const auctions = await ChitAuction.find({ chitFund: chitId }).sort({ monthNumber: 1 }).lean();
        
        // Build timeline from Month 1 to chit.totalMonths
        let auctionTimeline = [];
        for (let i = 1; i <= chit.totalMonths; i++) {
            const auctionForMonth = auctions.find(a => a.monthNumber === i);
            
            if (auctionForMonth) {
                // Populate winner info
                const winnerDoc = await User.findOne({ id: auctionForMonth.winnerUserId }).select('firstName lastName phone').lean();
                
                auctionTimeline.push({
                    monthNumber: i,
                    status: 'completed',
                    auctionDate: auctionForMonth.auctionDate,
                    winner: winnerDoc,
                    winningBidDiscount: auctionForMonth.winningBidDiscount,
                    dividendPerMember: auctionForMonth.dividendPerMember,
                    prizeMoneyPaid: auctionForMonth.prizeMoneyPaid
                });
            } else {
                // Determine if this is the currently pending/active auction, or a future one
                const status = (i === chit.completedMonths + 1) ? 'active' : 'pending';
                
                auctionTimeline.push({
                    monthNumber: i,
                    status: status,
                    auctionDate: null,
                    winner: null,
                    winningBidDiscount: 0,
                    dividendPerMember: 0,
                    prizeMoneyPaid: 0
                });
            }
        }

        res.status(200).json({
            success: true,
            chitDetails: {
                id: chit._id,
                name: chit.name,
                totalValue: chit.totalValue,
                totalMonths: chit.totalMonths,
                completedMonths: chit.completedMonths,
                monthlySubscription: chit.monthlySubscription,
                status: chit.status,
                isOwner: chit.owner.toString() === req.user.id,
                startDate: chit.startDate,
                currentSubscribersCount: chit.currentSubscribersCount,
                activeAuctionMonth: chit.activeAuctionMonth,
                activeAuctionBaseAmount: chit.activeAuctionBaseAmount
            },
            members,
            auctionTimeline
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Delete a Chit Fund (Owner Only)
// @route   DELETE /api/chits/:id
// @access  Private
exports.deleteChitFund = async (req, res) => {
    try {
        const chitId = req.params.id;
        const chit = await ChitFund.findById(chitId);

        if (!chit) {
            return res.status(404).json({ success: false, message: 'Chit not found' });
        }

        if (chit.owner.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only the group owner can delete this chit fund' });
        }

        // Delete all associated data
        await ChitSubscription.deleteMany({ chitFund: chitId });
        const ChitAuction = require('../models/ChitAuction');
        await ChitAuction.deleteMany({ chitFund: chitId });
        const ChitInvite = require('../models/ChitInvite');
        await ChitInvite.deleteMany({ chitFund: chitId });
        
        // Finally, delete the Chit Fund itself
        await ChitFund.findByIdAndDelete(chitId);

        res.status(200).json({ success: true, message: 'Chit Fund and all associated data deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Open an auction for a specific month
// @route   POST /api/chits/:id/auction/open
// @access  Private (Owner Only)
exports.openAuctionMonth = async (req, res) => {
    try {
        const chitId = req.params.id;
        const { monthNumber, baseAmount } = req.body;

        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });

        if (chit.owner.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only the group owner can open an auction' });
        }

        chit.activeAuctionMonth = monthNumber;
        chit.activeAuctionBaseAmount = baseAmount;
        if (chit.status === 'registration') {
            chit.status = 'active';
            chit.startDate = new Date();
        }
        await chit.save();

        // Broadcast notification to all active subscribers
        const ChitSubscription = require('../models/ChitSubscription');
        const subscribers = await ChitSubscription.find({ chitFund: chitId });
        const { sendPushNotification } = require('../utils/fcm');
        
        for (let sub of subscribers) {
            const memberUser = await User.findOne({ id: sub.user });
            if (memberUser && memberUser.fcmToken) {
                await sendPushNotification(
                    memberUser.fcmToken,
                    `Auction Opened for Month ${monthNumber}`,
                    `The auction for ${chit.name} is now open! Please submit your bids or pay the due amount of ₹${baseAmount}.`,
                    { type: 'AUCTION_OPENED', chitId: chit._id.toString() }
                );
            }
        }

        res.status(200).json({ success: true, message: `Auction opened for month ${monthNumber}` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    User submits a bid for the open auction month
// @route   POST /api/chits/:id/auction/bid
// @access  Private
exports.submitBid = async (req, res) => {
    try {
        const chitId = req.params.id;
        const { bidDiscount } = req.body;
        
        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });
        
        if (!chit.activeAuctionMonth) {
             return res.status(400).json({ success: false, message: 'No auction is currently open for bidding' });
        }

        const ChitSubscription = require('../models/ChitSubscription');
        const sub = await ChitSubscription.findOne({ user: req.user.id, chitFund: chitId });
        if (!sub) return res.status(403).json({ success: false, message: 'Not subscribed to this chit fund' });

        if (sub.hasWonAuction) {
             return res.status(403).json({ success: false, message: 'You have already won a previous auction' });
        }

        const ChitBid = require('../models/ChitBid');
        
        let existingBid = await ChitBid.findOne({ chitFund: chitId, monthNumber: chit.activeAuctionMonth, user: req.user.id });
        if (existingBid) {
            existingBid.bidDiscount = bidDiscount;
            await existingBid.save();
        } else {
            await ChitBid.create({
                chitFund: chitId,
                monthNumber: chit.activeAuctionMonth,
                user: req.user.id,
                bidDiscount
            });
        }

        res.status(200).json({ success: true, message: 'Bid submitted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get all bids for a specific auction month
// @route   GET /api/chits/:id/auction/:month/bids
// @access  Private (Owner Only)
exports.getAuctionBids = async (req, res) => {
    try {
        const chitId = req.params.id;
        const monthNumber = parseInt(req.params.month);
        
        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });
        
        if (chit.owner.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only the group owner can view bids' });
        }

        const ChitBid = require('../models/ChitBid');
        let bids = await ChitBid.find({ chitFund: chitId, monthNumber }).sort({ bidDiscount: -1 }).lean();
        
        for (let bid of bids) {
            const userDoc = await User.findOne({ id: bid.user }).select('firstName lastName phone').lean();
            bid.user = userDoc;
        }

        res.status(200).json({ success: true, bids });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Verify a member's payment for a specific month
// @route   POST /api/chits/:id/auction/:month/verify-payment
// @access  Private (Owner Only)
exports.verifyMonthPayment = async (req, res) => {
    try {
        const chitId = req.params.id;
        const monthNumber = parseInt(req.params.month);
        const { subscriberId, isPaid } = req.body;

        const chit = await ChitFund.findById(chitId);
        if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });

        if (chit.owner.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only the group owner can verify payments' });
        }

        if (subscriberId === 'synthetic_owner_sub') {
            return res.status(200).json({ success: true, message: 'Owner payments are automatically verified' });
        }

        const ChitSubscription = require('../models/ChitSubscription');
        const sub = await ChitSubscription.findById(subscriberId);
        if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });
        
        if (!sub.transactions) sub.transactions = [];

        // Update the transactions array to reflect payment for this specific month
        if (isPaid) {
            // Check if already paid
            const existingTx = sub.transactions.find(t => t.monthNumber === monthNumber);
            if (!existingTx) {
                sub.transactions.push({
                    monthNumber,
                    amountPaid: chit.activeAuctionBaseAmount || (chit.totalValue / chit.totalMonths), // approximate fallback
                    transactionId: 'MANUAL_OWNER_VERIFIED',
                    date: new Date()
                });
                sub.installmentsPaid = sub.transactions.length;
            }
        } else {
            // Remove the payment for this month if owner toggles it off
            sub.transactions = sub.transactions.filter(t => t.monthNumber !== monthNumber);
            sub.installmentsPaid = sub.transactions.length;
        }

        // Adjust defaulted status if they are up to date
        if (sub.installmentsPaid >= chit.completedMonths) {
            sub.status = 'active'; 
        } else {
            sub.status = 'defaulted';
        }

        await sub.save();
        res.status(200).json({ success: true, message: `Payment status updated for month ${monthNumber}` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
