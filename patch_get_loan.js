const fs = require("fs");
let lines = fs.readFileSync("controllers/loans.js", "utf8").split("\n");

let startIdx = lines.findIndex(l => l.includes("exports.getLoanById = async"));
let endIdx = -1;
for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].includes("res.status(500).json({ success: false, message: \"Server Error\" });")) {
        endIdx = i + 2;
        break;
    }
}

if (startIdx >= 0 && endIdx > startIdx) {
    const replacement = `exports.getLoanById = async (req, res) => {
    try {
        const loan = await Loan.findById(req.params.id);
        if (!loan) return res.status(404).json({ success: false, message: "Loan not found" });
        
        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: "Not authorized" });
        }

        const lenderUser = await User.findOne({ id: loan.lender });
        const borrowerUser = await User.findOne({ id: loan.borrower });

        const { loanSerializer } = require("../utils/loanSerializer");
        const loanObj = loanSerializer(loan);

        if (lenderUser) {
            loanObj.lenderName = \`\${lenderUser.firstName || ""} \${lenderUser.lastName || ""}\`.trim() || "Unknown Lender";
            loanObj.lenderPhone = lenderUser.phone;
        } else {
            loanObj.lenderName = "Unknown Lender";
            loanObj.lenderPhone = "";
        }

        if (borrowerUser) {
            loanObj.borrowerName = \`\${borrowerUser.firstName || ""} \${borrowerUser.lastName || ""}\`.trim() || loan.borrowerName || "Unknown Borrower";
            loanObj.borrowerPhone = borrowerUser.phone;
        }

        res.status(200).json({ success: true, loan: loanObj });
    } catch (err) {
        console.error("[Loans] getLoanById Error:", err.message);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};`;

    lines.splice(startIdx, endIdx - startIdx, replacement);
    fs.writeFileSync("controllers/loans.js", lines.join("\n"));
}

