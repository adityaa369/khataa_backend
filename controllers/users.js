const User = require('../models/User');

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
exports.getProfile = async (req, res) => {
    try {
        const user = await User.findOne({ id: req.user.id });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        // DTO Minimization: Mask highly sensitive KYC fields!
        const UserProfileResponse = {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            phone: '******' + String(user.phone).slice(-4),
            email: user.email,
            city: user.city,
            isVerified: user.isVerified,
            kycStatus: user.aadhar && user.pan ? 'verified' : 'pending',
            // Masked identifiers
            pan: user.pan ? '******' + user.pan.slice(-4) : null,
            aadhar: user.aadhar ? '********' + user.aadhar.slice(-4) : null
        };

        res.status(200).json({ success: true, user: UserProfileResponse });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
exports.updateProfile = async (req, res) => {
    try {
        const user = await User.findOneAndUpdate(
            { id: req.user.id },
            req.body,
            { new: true, runValidators: true }
        );
        res.status(200).json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

