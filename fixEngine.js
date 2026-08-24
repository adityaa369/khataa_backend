const fs = require('fs');
let code = fs.readFileSync('sockets/auctionEngine.js', 'utf8');
code = code.replace(/function initAuctionEngine\(server\) \{\s*let ioInstance;/g, "let ioInstance;\nfunction initAuctionEngine(server) {");
fs.writeFileSync('sockets/auctionEngine.js', code);
