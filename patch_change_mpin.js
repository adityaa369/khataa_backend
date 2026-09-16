const fs = require("fs");
let code = fs.readFileSync("controllers/auth.js", "utf8");

const changeMpinCode = `
// @desc    Change MPIN for the authenticated user
// @route   POST /api/auth/mpin/change
// @access  Private
exports.changeMpin = async (req, res) => {
    const { mpin } = req.body;
    if (!mpin || mpin.length !== 6) {
        return res.status(400).json({ success: false, message: "Invalid MPIN" });
    }
    try {
        const existingMpin = await MPinCredential.findOne({ userId: req.user.id });
        if (!existingMpin) {
            return res.status(400).json({ success: false, message: "No MPIN found. Please use the Setup MPIN flow." });
        }

        const salt = await bcrypt.genSalt(12);
        const hash = await bcrypt.hash(mpin, salt);
        
        existingMpin.mpinHash = hash;
        existingMpin.failedAttempts = 0;
        existingMpin.lockoutUntil = null;
        await existingMpin.save();

        const redisClient = getRedisClient();
        if (redisClient) {
            await redisClient.del(\`mpin_attempts:\${req.user.id}\`);
        }

        res.status(200).json({ success: true, message: "MPIN changed successfully" });
    } catch (err) {
        console.error("[Auth] changeMpin error:", err.message);
        res.status(500).json({ success: false, message: "Server error" });
    }
};
`;

code += changeMpinCode;
fs.writeFileSync("controllers/auth.js", code);

let routesCode = fs.readFileSync("routes/auth.js", "utf8");
routesCode = routesCode.replace(
    "const { register, login, getMe, updateDetails, setupMpin, verifyMpin, getMpinStatus } = require(\"../controllers/auth\");",
    "const { register, login, getMe, updateDetails, setupMpin, verifyMpin, getMpinStatus, changeMpin } = require(\"../controllers/auth\");"
);
routesCode = routesCode.replace(
    "router.post(\"/mpin/setup\", protect, setupMpin);",
    "router.post(\"/mpin/setup\", protect, setupMpin);\nrouter.post(\"/mpin/change\", protect, changeMpin);"
);
fs.writeFileSync("routes/auth.js", routesCode);

