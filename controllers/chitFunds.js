const ChitFund = require('../models/ChitFund');
const ChitSubscription = require('../models/ChitSubscription');
const ChitAuction = require('../models/ChitAuction');
const ChitInvite = require('../models/ChitInvite');
const User = require('../models/User');

// @desc    Create a new Chit Fund (Dynamic config by Owner)
// @route   POST /api/chits/create
// @access  Private
exports.createChitFund = async (req, res) => {
    try {
        const { name, totalValue, totalMonths, organizerFeePercent, branchName } = req.body;

        if (!name || !totalValue || !totalMonths || !organizerFeePercent) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        const monthlySubscription = totalValue / totalMonths;

        const chit = await ChitFund.create({
            name,
            totalValue,
            totalMonths,
            monthlySubscription,
            organizerFeePercent,
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

// @desc    Get all vacant chits (registration phase)
// @route   GET /api/chits/vacant
// @access  Private
exports.getVacantChits = async (req, res) => {
    try {
        const chits = await ChitFund.find({ status: 'registration', owner: req.user.id });
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
        const result = subs.map(sub => {
            const chit = sub.chitFund;
            // Mock calculation for UI purposes - real logic would calculate based on ChitAuction dividends
            const dueAmount = chit.monthlySubscription * 0.9; // Example: 10% dividend discount
            
            return {
                id: sub._id,
                chitId: chit._id,
                chitName: chit.name,
                branchName: chit.branchName,
                totalValue: chit.totalValue,
                totalMonths: chit.totalMonths,
                completedMonths: chit.completedMonths,
                dueAmount: dueAmount,
                status: sub.status
            };
        });

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
        res.status(200).json({ success: true, message: 'Bid authorized and submitted successfully' });
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

        // Record the transaction
        sub.transactions.push({
            monthNumber,
            amountPaid,
            transactionId,
            date: new Date()
        });

        sub.installmentsPaid += 1;
        
        // Check if user is now up to date
        const chit = await ChitFund.findById(req.params.id);
        if (sub.installmentsPaid >= chit.completedMonths && sub.status === 'defaulted') {
             sub.status = 'active'; // Restore eligibility
        }

        await sub.save();

        res.status(200).json({ success: true, message: 'Installment paid successfully', receipt: transactionId });
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
            const owner = await User.findById(chit.owner);
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
