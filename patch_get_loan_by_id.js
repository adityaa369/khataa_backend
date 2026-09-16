const fs = require("fs");
let code = fs.readFileSync("controllers/loans.js", "utf8");

const replacement = `exports.getLoanById = async (req, res) => {
    try {
        const loan = await Loan.findById(req.params.id).lean();
        if (!loan) return res.status(404).json({ success: false, message: "Loan not found" });
        
        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: "Not authorized" });
        }

        const lenderUser = await User.findOne({ id: loan.lender });
        const borrowerUser = await User.findOne({ id: loan.borrower });

        loan.lender = lenderUser ? { id: lenderUser.id, firstName: lenderUser.firstName, lastName: lenderUser.lastName, phone: lenderUser.phone } : { id: loan.lender, firstName: "Unknown", lastName: "Lender" };
        loan.borrower = borrowerUser ? { id: borrowerUser.id, firstName: borrowerUser.firstName, lastName: borrowerUser.lastName, phone: borrowerUser.phone } : { id: loan.borrower, firstName: "Unknown", lastName: "Borrower" };

        res.status(200).json({ success: true, loan });
    } catch (err) {
        console.error("[Loans] getLoanById Error:", err.message);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};`;

code = code.replace(/exports\.getLoanById = async \(req, res\) => \{[\s\S]*?res\.status\(500\)\.json\(\{ success: false, message: .Server Error. \}\);\s*\n\s*\}\s*;\s*\n/, replacement + "\n\n");
fs.writeFileSync("controllers/loans.js", code);

