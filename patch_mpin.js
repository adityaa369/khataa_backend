const fs = require("fs");
let code = fs.readFileSync("controllers/auth.js", "utf8");

code = code.replace(
    /await MPinCredential\.findOneAndUpdate\([\s\S]*?\{ upsert: true, new: true \}\s*\);/,
    `const existingMpin = await MPinCredential.findOne({ userId: req.user.id });
        if (existingMpin) {
            return res.status(400).json({ success: false, message: "MPIN already exists. Please use the Change MPIN flow." });
        }
        await MPinCredential.create({
            userId: req.user.id,
            firebaseUid: req.user.firebaseUid || ("mock_uid_" + req.user.phone),
            mpinHash: hash,
            failedAttempts: 0,
            lockoutUntil: null
        });`
);
fs.writeFileSync("controllers/auth.js", code);

