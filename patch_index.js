const fs = require("fs");
let indexCode = fs.readFileSync("index.js", "utf8");
indexCode = indexCode.replace(
    "app.use('/api/loans', require('./routes/loans'));",
    "app.use('/api/loans', require('./routes/loans'));\napp.use('/api/debug', require('./routes/debug'));"
);
fs.writeFileSync("index.js", indexCode);

