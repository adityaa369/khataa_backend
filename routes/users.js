const express = require('express');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
router.get('/profile', async (req, res) => {
    try {
        const user = await User.findOne({ id: req.user.id });
        res.status(200).json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// @desc    Update user profile details
// @route   PUT /api/users/profile
// @access  Private
router.put('/profile', async (req, res) => {
    try {
        const { firstName, lastName, email, pan, aadhar, dob, gender } = req.body;

        const user = await User.findOneAndUpdate(
            { id: req.user.id },
            {
                firstName,
                lastName,
                email,
                pan,
                aadhar,
                dob,
                gender
            },
            { new: true, runValidators: true }
        );

        res.status(200).json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// @desc    Check if user exists by phone
// @route   POST /api/users/check-phone
// @access  Private
router.post('/check-phone', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Phone number required' });
        }

        const user = await User.findOne({ phone });

        if (user) {
            res.status(200).json({
                success: true,
                exists: true,
                user: {
                    firstName: user.firstName,
                    lastName: user.lastName,
                    id: user.id
                }
            });
        } else {
            res.status(200).json({ success: true, exists: false });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// @desc    Update FCM Token
// @route   POST /api/users/fcm-token
// @access  Private
router.post('/fcm-token', async (req, res) => {
    try {
        const { fcmToken } = req.body;
        if (!fcmToken) {
            return res.status(400).json({ success: false, message: 'Token required' });
        }
        const userObj = await User.findOneAndUpdate(
            { id: req.user.id },
            { fcmToken },
            { new: true }
        );
        if (userObj) {
            const DeviceToken = require('../models/DeviceToken');
            await DeviceToken.findOneAndUpdate(
                { token: fcmToken },
                {
                    userId: userObj._id,
                    token: fcmToken,
                    lastSeenAt: new Date(),
                    active: true
                },
                { upsert: true, new: true }
            );
        }
        res.status(200).json({ success: true, message: 'Token updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// @desc    Revoke a specific FCM device token (e.g., on logout from that device)
// @route   DELETE /api/users/fcm-token
// @access  Private
router.delete('/fcm-token', async (req, res) => {
    try {
        const { fcmToken } = req.body;
        if (!fcmToken) {
            return res.status(400).json({ success: false, message: 'fcmToken required' });
        }
        // Deactivate only this specific device — never other devices
        const DeviceToken = require('../models/DeviceToken');
        await DeviceToken.findOneAndUpdate(
            { token: fcmToken, userId: req.user._id },
            { active: false }
        );
        res.status(200).json({ success: true, message: 'Device token revoked' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// @desc    Get notification preferences
// @route   GET /api/users/notification-preferences
// @access  Private
router.get('/notification-preferences', async (req, res) => {
    try {
        const user = await User.findOne({ id: req.user.id }).select('notificationPreferences');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        // Return with secure defaults if not set yet
        const prefs = user.notificationPreferences || {};
        res.status(200).json({
            success: true,
            preferences: {
                loanUpdates:     prefs.loanUpdates     ?? true,
                paymentUpdates:  prefs.paymentUpdates  ?? true,
                securityAlerts:  true, // MANDATORY — always true
                kycUpdates:      prefs.kycUpdates      ?? true,
                chitFundUpdates: prefs.chitFundUpdates ?? true,
                promotional:     prefs.promotional     ?? false,
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// @desc    Update notification preferences
// @route   PUT /api/users/notification-preferences
// @access  Private
router.put('/notification-preferences', async (req, res) => {
    try {
        const { loanUpdates, paymentUpdates, kycUpdates, chitFundUpdates, promotional } = req.body;
        
        const updates = {};
        // securityAlerts is MANDATORY — never allow disabling
        if (typeof loanUpdates    === 'boolean') updates['notificationPreferences.loanUpdates']     = loanUpdates;
        if (typeof paymentUpdates === 'boolean') updates['notificationPreferences.paymentUpdates']  = paymentUpdates;
        if (typeof kycUpdates     === 'boolean') updates['notificationPreferences.kycUpdates']      = kycUpdates;
        if (typeof chitFundUpdates=== 'boolean') updates['notificationPreferences.chitFundUpdates'] = chitFundUpdates;
        if (typeof promotional    === 'boolean') updates['notificationPreferences.promotional']     = promotional;

        await User.findOneAndUpdate({ id: req.user.id }, { $set: updates });
        res.status(200).json({ success: true, message: 'Preferences updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
