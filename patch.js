const fs = require("fs");
const debugRouteContent = `const express = require("express");
const router = express.Router();
const Loan = require("../models/Loan");
const User = require("../models/User");

router.get("/loan", async (req, res) => {
    try {
        const loans = await Loan.find().sort({ createdAt: -1 }).limit(1);
        if (loans.length === 0) return res.json({ msg: "No loans" });
        const loan = loans[0];
        const borrower = await User.findOne({ id: loan.borrower });
        const borrowerByPhone = await User.findOne({ phone: new RegExp(loan.borrowerPhone + "$") });
        res.json({ loan, borrowerUser: borrower, borrowerByPhone });
    } catch (e) { res.json({ error: e.message }); }
});

module.exports = router;`;
fs.writeFileSync("routes/debug.js", debugRouteContent);
let indexContent = fs.readFileSync("index.js", "utf8");
if (!indexContent.includes("/api/debug")) {
    indexContent = indexContent.replace(
        "app.use(\"/api/loans\", require(\"./routes/loans\"));",
        "app.use(\"/api/loans\", require(\"./routes/loans\"));\napp.use(\"/api/debug\", require(\"./routes/debug\"));"
    );
    fs.writeFileSync("index.js", indexContent);
}
