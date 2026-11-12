const mongoose = require('mongoose');
const User = require('../models/User');
const Loan = require('../models/Loan');
const CreditScore = require('../models/CreditScore');
const ChitSubscription = require('../models/ChitSubscription');
const SecurityEvent = require('../models/SecurityEvent');
const AdminAuditLog = require('../models/AdminAuditLog');
const { getTraceContext } = require('../utils/asyncContext');

exports.getCustomerOverview = async (req, res) => {
    try {
        const [totalCustomers, suspendedCount, emailVerifiedCount, aadhaarVerifiedCount, securityAlerts] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ isSuspended: true }),
            User.countDocuments({ isEmailVerified: true }),
            User.countDocuments({ isAadhaarVerified: true }),
            SecurityEvent.countDocuments({ severity: { $in: ['HIGH', 'CRITICAL'] } })
        ]);

        const active = Math.max(0, totalCustomers - suspendedCount);
        const pendingEmail = Math.max(0, totalCustomers - emailVerifiedCount);

        res.status(200).json({
            success: true,
            data: {
                totalCustomers,
                active,
                suspendedCount,
                emailVerifiedCount,
                aadhaarVerifiedCount,
                pendingKyc: pendingEmail,
                activeSessions: active,
                securityAlerts
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

exports.getCustomers = async (req, res) => {
    try {
        const search = (req.query.search || '').trim();
        const query = search ? {
            $or: [
                { phone: { $regex: search, $options: 'i' } },
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { city: { $regex: search, $options: 'i' } }
            ]
        } : {};

        const users = await User.find(query)
            .select('-password -pan -aadhar -aadhaarHash -aadhaarKycData.photoBase64 -emailVerificationToken')
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        res.status(200).json({ success: true, data: users });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

exports.getCustomerDetail = async (req, res) => {
    try {
        const paramId = req.params.id;
        const query = mongoose.Types.ObjectId.isValid(paramId)
            ? { $or: [{ id: paramId }, { _id: paramId }] }
            : { id: paramId };

        const user = await User.findOne(query).select('-password -emailVerificationToken');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const [loans, chits, creditScore] = await Promise.all([
            Loan.find({
                $or: [
                    { lender: user.id },
                    { borrower: user.id },
                    { borrowerPhone: user.phone }
                ]
            }).sort({ createdAt: -1 }).limit(50).lean(),
            ChitSubscription.find({ user: user._id }).populate('chitFund', 'name status').lean().catch(() => []),
            CreditScore.findOne({ user: user.id }).lean()
        ]);

        const maskedUser = user.toObject();
        delete maskedUser.aadhaarHash;
        if (maskedUser.aadhaarKycData) delete maskedUser.aadhaarKycData.photoBase64;
        if (maskedUser.pan) maskedUser.pan = 'XXXXXX' + maskedUser.pan.slice(-4);
        if (maskedUser.aadhar) maskedUser.aadhar = maskedUser.aadhaarMasked || ('XXXXXXXX' + maskedUser.aadhar.slice(-4));

        const enrichedLoans = loans.map(l => ({
            ...l,
            role: l.lender === user.id ? 'CREDITOR (GIVEN)' : 'COUNTERPARTY (TAKEN)',
            amountPaise: typeof l.amountPaise === 'number' ? l.amountPaise : Math.round((l.amount || 0) * 100),
            paidAmountPaise: typeof l.paidAmountPaise === 'number' ? l.paidAmountPaise : Math.round((l.paidAmount || 0) * 100),
            totalPayablePaise: typeof l.totalPayablePaise === 'number' ? l.totalPayablePaise : Math.round((l.totalPayable || l.amount || 0) * 100)
        }));

        res.status(200).json({
            success: true,
            data: {
                user: maskedUser,
                loans: enrichedLoans,
                chits,
                creditScore,
                timeline: [
                    { time: user.createdAt, event: 'Account Registered on HandCredit', status: 'SUCCESS' },
                    ...(user.isEmailVerified ? [{ time: user.updatedAt, event: 'Email Address Verified', status: 'SUCCESS' }] : []),
                    ...(user.isAadhaarVerified ? [{ time: user.aadhaarVerifiedAt || user.updatedAt, event: `UIDAI Aadhaar eKYC Verified (${user.aadhaarMasked || 'XXXX'})`, status: 'SUCCESS' }] : []),
                    ...(user.isSuspended ? [{ time: user.updatedAt, event: 'Account Suspended by Operator', status: 'BLOCKED' }] : [])
                ]
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

exports.unmaskKYC = async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ success: false, message: 'Mandatory reason required' });

        const paramId = req.params.id;
        const query = mongoose.Types.ObjectId.isValid(paramId)
            ? { $or: [{ id: paramId }, { _id: paramId }] }
            : { id: paramId };

        const user = await User.findOne(query).select('id pan aadhar isVerified isEmailVerified phone email dob address city');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const { requestId } = getTraceContext();
        await AdminAuditLog.create({
            adminId: req.admin._id,
            action: 'KYC_VIEWED',
            reason: reason,
            status: 'SUCCESS',
            ipAddress: req.ip,
            requestId,
            resourceType: 'User',
            resourceId: user.id || user._id.toString()
        });

        res.status(200).json({
            success: true,
            data: {
                phone: user.phone,
                email: user.email,
                dob: user.dob,
                city: user.city,
                address: user.address,
                pan: user.pan || 'Not collected (v1.0 Policy)',
                aadhar: user.aadhar || 'Not collected (v1.0 Policy)'
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};
