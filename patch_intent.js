const fs = require("fs");
let code = fs.readFileSync("models/TransactionIntent.js", "utf8");
code = code.replace("enum: ['CLOSE_LOAN', 'PAYMENT', 'ADD_CREDIT']", "enum: ['CLOSE_LOAN', 'PAYMENT', 'ADD_CREDIT', 'ACCEPT_LOAN']");
fs.writeFileSync("models/TransactionIntent.js", code);

