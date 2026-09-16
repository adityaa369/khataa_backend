const fs = require("fs");
let routesCode = fs.readFileSync("routes/auth.js", "utf8");
routesCode = routesCode.replace(
    "router.post('/mpin/setup', protect, authController.setupMpin);",
    "router.post('/mpin/setup', protect, authController.setupMpin);\nrouter.post('/mpin/change', protect, authController.changeMpin);"
);
fs.writeFileSync("routes/auth.js", routesCode);

