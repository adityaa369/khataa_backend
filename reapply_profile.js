const fs = require('fs');

let userJs = fs.readFileSync('models/User.js', 'utf8');
if (!userJs.includes('profileImageId')) {
    userJs = userJs.replace(
        '    address: String,\n',
        '    address: String,\n    profileImageId: String,\n'
    );
    fs.writeFileSync('models/User.js', userJs);
}

let authCtrl = fs.readFileSync('controllers/auth.js', 'utf8');
if (!authCtrl.includes('exports.updateProfile')) {
    const updateProfileLogic = `
// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
exports.updateProfile = asyncHandler(async (req, res, next) => {
    const fieldsToUpdate = {};
    if (req.body.profileImageId !== undefined) fieldsToUpdate.profileImageId = req.body.profileImageId;
    
    // Only allow updating profileImageId for now, expand if needed
    const user = await User.findByIdAndUpdate(
        req.user.id,
        fieldsToUpdate,
        { new: true, runValidators: true }
    );

    res.status(200).json({
        success: true,
        data: user
    });
});
`;
    authCtrl += updateProfileLogic;
    fs.writeFileSync('controllers/auth.js', authCtrl);
}

let authRoutes = fs.readFileSync('routes/auth.js', 'utf8');
if (!authRoutes.includes('updateProfile')) {
    authRoutes = authRoutes.replace(
        "router.get('/me', protect, authController.getMe);",
        "router.get('/me', protect, authController.getMe);\nrouter.put('/profile', protect, authController.updateProfile);"
    );
    fs.writeFileSync('routes/auth.js', authRoutes);
}

console.log("Applied profile changes.");
