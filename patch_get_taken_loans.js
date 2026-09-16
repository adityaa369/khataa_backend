const fs = require("fs");
let code = fs.readFileSync("controllers/loans.js", "utf8");

code = code.replace(
    /\$or:\s*\[\s*\{\s*borrowerPhone:\s*phone\s*\},\s*\{\s*borrower:\s*req\.user\.id\s*\}\s*\],/,
    "borrower: req.user.id,"
);

fs.writeFileSync("controllers/loans.js", code);

