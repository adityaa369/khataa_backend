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

module.exports = router;
