const express = require('express');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { lookupLimiter } = require('../middleware/rateLimiter');

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
router.post('/check-phone', lookupLimiter, async (req, res) => {
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
          const { fcmToken, platform, appVersion } = req.body;
          if (!fcmToken) {
              return res.status(400).json({ success: false, message: 'Token required' });
          }

          const DeviceToken = require('../models/DeviceToken');
          
          // Deactivate this token for any other user to prevent cross-account leakage
          await DeviceToken.updateMany(
              { token: fcmToken, userId: { $ne: req.user._id } },
              { $set: { active: false } }
          );

          // Upsert for current user
          await DeviceToken.findOneAndUpdate(
              { token: fcmToken },
              { 
                  userId: req.user._id,
                  platform: platform || 'unknown',
                  appVersion,
                  active: true,
                  lastSeenAt: new Date()
              },
              { upsert: true, new: true }
          );

          res.status(200).json({ success: true, message: 'Token updated' });
      } catch (err) {
          res.status(500).json({ success: false, message: err.message });
      }
  });

  // @desc    Logout and Unbind FCM Token
  // @route   POST /api/users/logout
  // @access  Private
  router.post('/logout', async (req, res) => {
      try {
          const { fcmToken } = req.body;
          if (fcmToken) {
              const DeviceToken = require('../models/DeviceToken');
              await DeviceToken.updateOne(
                  { token: fcmToken, userId: req.user._id },
                  { $set: { active: false } }
              );
          }
          res.status(200).json({ success: true, message: 'Logged out successfully' });
      } catch (err) {
          res.status(500).json({ success: false, message: err.message });
      }
  });

  // @desc    Unbind FCM Token explicitly
  // @route   DELETE /api/users/fcm-token
  // @access  Private
  router.delete('/fcm-token', async (req, res) => {
      try {
          const { fcmToken } = req.body;
          if (!fcmToken) {
              return res.status(400).json({ success: false, message: 'Token required' });
          }
          const DeviceToken = require('../models/DeviceToken');
          await DeviceToken.updateOne(
              { token: fcmToken, userId: req.user._id },
              { $set: { active: false } }
          );
          res.status(200).json({ success: true, message: 'Token unbound' });
      } catch (err) {
          res.status(500).json({ success: false, message: err.message });
      }
  });
  
  module.exports = router;
