const fs = require('fs');
let c1 = fs.readFileSync('controllers/loans.js', 'utf8');
c1 = c1.replace(/exports\.toggleMonthStatus = async[\s\S]*?res\.status\(500\)\.json\(\{ success: false, message: 'Server Error' \}\);\n\s*\}\n\};\n?/m, '');
fs.writeFileSync('controllers/loans.js', c1);
