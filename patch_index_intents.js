const fs = require("fs");
let code = fs.readFileSync("index.js", "utf8");

if (!code.includes("const intentRoutes = require('./routes/intents');")) {
    code = code.replace("const loanRoutes = require('./routes/loans');", "const loanRoutes = require('./routes/loans');\nconst intentRoutes = require('./routes/intents');");
}

if (!code.includes("app.use('/api/intents', intentRoutes);")) {
    code = code.replace("app.use('/api/loans', loanRoutes);", "app.use('/api/loans', loanRoutes);\napp.use('/api/intents', intentRoutes);");
}

fs.writeFileSync("index.js", code);

