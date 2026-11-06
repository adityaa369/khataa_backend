const User = require('../models/User');

function isAdultDob(dobStr) {
    if (!dobStr || typeof dobStr !== 'string') return false;
    const trimmed = dobStr.trim();
    let day, month, year;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
        const parts = trimmed.split('/');
        day = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10);
        year = parseInt(parts[2], 10);
    } else {
        const parsed = new Date(trimmed);
        if (isNaN(parsed.getTime())) return false;
        day = parsed.getUTCDate();
        month = parsed.getUTCMonth() + 1;
        year = parsed.getUTCFullYear();
    }
    if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const birthDate = new Date(Date.UTC(year, month - 1, day));
    if (
        birthDate.getUTCFullYear() !== year ||
        birthDate.getUTCMonth() !== month - 1 ||
        birthDate.getUTCDate() !== day
    ) {
        return false;
    }
    const now = new Date();
    let age = now.getUTCFullYear() - year;
    const mDiff = (now.getUTCMonth() + 1) - month;
    if (mDiff < 0 || (mDiff === 0 && now.getUTCDate() < day)) {
        age--;
    }
    return age >= 18 && age <= 105;
}

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
exports.getProfile = async (req, res) => {
    try {
        const user = await User.findOne({ id: req.user.id });
        res.status(200).json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
exports.updateProfile = async (req, res) => {
    try {
        if (req.body.dob !== undefined) {
            if (!isAdultDob(req.body.dob)) {
                return res.status(400).json({
                    success: false,
                    message: 'Age Restriction (18+ Only): You must be at least 18 years old to use HandCredit under the Indian Contract Act, 1872.'
                });
            }
            if (req.user && req.user.dob && req.user.dob.trim() !== '' && req.user.dob !== req.body.dob) {
                return res.status(400).json({
                    success: false,
                    message: 'Date of Birth is permanently locked after registration for compliance.'
                });
            }
        }
        const allowedFields = ['firstName', 'lastName', 'email', 'pan', 'aadhar', 'dob', 'gender', 'city', 'address'];
        const updates = {};
        allowedFields.forEach((f) => {
            if (req.body[f] !== undefined) updates[f] = req.body[f];
        });
        const user = await User.findOneAndUpdate(
            { id: req.user.id },
            { $set: updates },
            { new: true, runValidators: true }
        );
        res.status(200).json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
