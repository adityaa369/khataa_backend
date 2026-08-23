const User = require('../models/User');
const Loan = require('../models/Loan');
const ChitSubscription = require('../models/ChitSubscription');
const AdminAuditLog = require('../models/AdminAuditLog');
const { getTraceContext } = require('../utils/asyncContext');

exports.getCustomerOverview = async (req, res) => {
    const totalCustomers = await User.countDocuments();
    const pendingKyc = await User.countDocuments({ isKycVerified: false });
    // Mocking active sessions since it's Redis backed
    const activeSessions = Math.floor(totalCustomers * 0.4); 

    res.status(200).json({
        success: true,
        data: {
            totalCustomers,
            active: totalCustomers - 14,
            pendingKyc,
            activeSessions,
            securityAlerts: 19
        }
    });
};

exports.getCustomers = async (req, res) => {
    // F2 - Simplified search
    const users = await User.find().select('-password -pan -aadhar').sort({ createdAt: -1 }).limit(50);
    res.status(200).json({ success: true, data: users });
};

exports.getCustomerDetail = async (req, res) => {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const loans = await Loan.find({ user: user._id }).select('amountPaise status createdAt');
    const chits = await ChitSubscription.find({ user: user._id }).populate('chitFund', 'name status');

    // MASK KYC DATA BY DEFAULT
    const maskedUser = user.toObject();
    if (maskedUser.pan) maskedUser.pan = '••••••' + maskedUser.pan.slice(-4);
    if (maskedUser.aadhar) maskedUser.aadhar = '••••••••' + maskedUser.aadhar.slice(-4);

    res.status(200).json({
        success: true,
        data: {
            user: maskedUser,
            loans,
            chits,
            timeline: [
                { time: user.createdAt, event: 'User Registered', status: 'SUCCESS' }
            ]
        }
    });
};

exports.unmaskKYC = async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Mandatory reason required' });

    const user = await User.findById(req.params.id).select('pan aadhar isKycVerified');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // CREATE IMMUTABLE AUDIT LOG
    const { requestId } = getTraceContext();
    await AdminAuditLog.create({
        adminId: req.admin._id,
        action: 'KYC_VIEWED',
        reason: reason,
        status: 'SUCCESS',
        ipAddress: req.ip,
        requestId,
        resourceType: 'User',
        resourceId: user._id.toString()
    });

    res.status(200).json({
        success: true,
        data: {
            pan: user.pan,
            aadhar: user.aadhar
        }
    });
};
