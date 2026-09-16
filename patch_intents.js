const fs = require("fs");
let code = fs.readFileSync("controllers/intents.js", "utf8");
code = code.replace("const crypto = require(\"crypto\");\n        const intent", "const intent");
code = "const crypto = require(\"crypto\");\n" + code;
fs.writeFileSync("controllers/intents.js", code);

