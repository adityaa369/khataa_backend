const fs = require("fs");
let code = fs.readFileSync("routes/auth.js", "utf8");

let newRoute = `router.get('/verify-email/:token', authController.verifyEmail);
router.post('/sync-firebase', protect, authController.syncFirebase);`;

code = code.replace("router.get('/verify-email/:token', authController.verifyEmail);", newRoute);
fs.writeFileSync("routes/auth.js", code);

