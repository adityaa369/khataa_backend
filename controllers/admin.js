const User = require('../models/User');
const Loan = require('../models/Loan');
const ChitFund = require('../models/ChitFund');
const CreditScore = require('../models/CreditScore');

function sendError(res, err, status = 500) {
    const isProd = process.env.NODE_ENV === 'production';
    return res.status(status).json({
        success: false,
        message: isProd && status === 500 ? 'Internal server error' : err.message
    });
}

// @desc    Get platform overview stats
// @route   GET /api/admin/stats
exports.getStats = async (req, res) => {
    try {
        const [totalUsers, totalLoans, totalChits, activeLoans, activeChits] = await Promise.all([
            User.countDocuments(),
            Loan.countDocuments(),
            ChitFund.countDocuments(),
            Loan.countDocuments({ status: 'active' }),
            ChitFund.countDocuments({ status: 'active' })
        ]);

        // Total loan volume
        const loanVolumeResult = await Loan.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]);
        const totalLoanVolume = loanVolumeResult[0]?.total || 0;

        // Total chit fund value
        const chitVolumeResult = await ChitFund.aggregate([{ $group: { _id: null, total: { $sum: '$totalValue' } } }]);
        const totalChitVolume = chitVolumeResult[0]?.total || 0;

        // New users last 30 days
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const newUsers = await User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } });

        // Loans created last 30 days
        const newLoans = await Loan.countDocuments({ createdAt: { $gte: thirtyDaysAgo } });

        res.json({
            success: true,
            stats: {
                totalUsers, totalLoans, totalChits, activeLoans, activeChits,
                totalLoanVolume, totalChitVolume, newUsers, newLoans
            }
        });
    } catch (err) { sendError(res, err); }
};

// @desc    Get all users (paginated)
// @route   GET /api/admin/users?page=1&search=phone
exports.getUsers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const search = req.query.search || '';
        const query = search ? {
            $or: [
                { phone: { $regex: search, $options: 'i' } },
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ]
        } : {};

        const [users, total] = await Promise.all([
            User.find(query).select('-password -emailVerificationToken').skip((page - 1) * limit).limit(limit).sort({ createdAt: -1 }),
            User.countDocuments(query)
        ]);

        res.json({ success: true, users, total, page, pages: Math.ceil(total / limit) });
    } catch (err) { sendError(res, err); }
};

// @desc    Get user detail with loans and chit funds
// @route   GET /api/admin/users/:id
exports.getUserDetail = async (req, res) => {
    try {
        const user = await User.findOne({ id: req.params.id }).select('-password -emailVerificationToken');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const [loans, chits, creditScore] = await Promise.all([
            Loan.find({ $or: [{ lender: req.params.id }, { borrower: req.params.id }] }).limit(10),
            ChitFund.find({ $or: [{ owner: req.params.id }, { 'members.user': req.params.id }] }).limit(10),
            CreditScore.findOne({ userId: req.params.id })
        ]);

        res.json({ success: true, user, loans, chits, creditScore });
    } catch (err) { sendError(res, err); }
};

// @desc    Suspend or unsuspend a user
// @route   PUT /api/admin/users/:id/suspend
exports.toggleSuspend = async (req, res) => {
    try {
        const { suspend } = req.body;
        const user = await User.findOneAndUpdate(
            { id: req.params.id },
            { isSuspended: suspend },
            { new: true }
        ).select('-password');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, user, message: suspend ? 'User suspended' : 'User unsuspended' });
    } catch (err) { sendError(res, err); }
};

// @desc    Get all loans (admin view)
// @route   GET /api/admin/loans?status=active&page=1
exports.getLoans = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        if (req.query.type) filter.loanType = req.query.type;

        const [loans, total] = await Promise.all([
            Loan.find(filter).skip((page - 1) * limit).limit(limit).sort({ createdAt: -1 }),
            Loan.countDocuments(filter)
        ]);

        res.json({ success: true, loans, total, page, pages: Math.ceil(total / limit) });
    } catch (err) { sendError(res, err); }
};

// @desc    Get all chit funds (admin view)
// @route   GET /api/admin/chit-funds
exports.getChitFunds = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const filter = {};
        if (req.query.status) filter.status = req.query.status;

        const [chits, total] = await Promise.all([
            ChitFund.find(filter).skip((page - 1) * limit).limit(limit).sort({ createdAt: -1 }),
            ChitFund.countDocuments(filter)
        ]);

        res.json({ success: true, chits, total, page, pages: Math.ceil(total / limit) });
    } catch (err) { sendError(res, err); }
};

// @desc    Make a user admin or remove admin
// @route   PUT /api/admin/users/:id/role
exports.setAdminRole = async (req, res) => {
    try {
        const { isAdmin } = req.body;
        const user = await User.findOneAndUpdate(
            { id: req.params.id },
            { isAdmin },
            { new: true }
        ).select('-password');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, user, message: isAdmin ? 'Admin role granted' : 'Admin role removed' });
    } catch (err) { sendError(res, err); }
};
