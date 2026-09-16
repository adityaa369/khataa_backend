const fs = require("fs");
let code = fs.readFileSync("controllers/auth.js", "utf8");

let newController = `

// @desc    Sync Firebase Email Verification State
// @route   POST /api/auth/sync-firebase
// @access  Private
exports.syncFirebase = async (req, res) => {
    try {
        const admin = require("firebase-admin");
        let idToken;
        
        if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
            idToken = req.headers.authorization.split(" ")[1];
        } else if (req.body.idToken) {
            idToken = req.body.idToken;
        }

        if (!idToken) {
            return res.status(401).json({ success: false, message: "Firebase ID token is required" });
        }

        const decodedToken = await admin.auth().verifyIdToken(idToken, true);
        
        if (decodedToken.email_verified === true) {
            const user = await User.findOneAndUpdate(
                { id: req.user.id },
                { isEmailVerified: true },
                { new: true, runValidators: true }
            );
            return res.status(200).json({ success: true, user });
        } else {
            return res.status(200).json({ success: false, message: "Email is not verified in Firebase", user: req.user });
        }
    } catch (err) {
        console.error("[Auth] syncFirebase error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};
`;

code = code + newController;
fs.writeFileSync("controllers/auth.js", code);

