const fs = require("fs");
let code = fs.readFileSync("controllers/loans.js", "utf8");

code = code.replace(
    /const isBorrower = String\(loan\.borrowerPhone\).*?;/,
    "const isBorrower = loan.borrower === req.user.id;"
);

fs.writeFileSync("controllers/loans.js", code);

