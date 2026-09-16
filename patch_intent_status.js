const fs = require("fs");
let code = fs.readFileSync("models/TransactionIntent.js", "utf8");
code = code.replace("enum: ['PENDING', 'COMMITTED', 'REJECTED']", "enum: ['PENDING', 'COMMITTED', 'COMPLETED', 'REJECTED']");
fs.writeFileSync("models/TransactionIntent.js", code);

