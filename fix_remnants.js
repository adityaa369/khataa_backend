const fs = require('fs');
let c1 = fs.readFileSync('controllers/loans.js', 'utf8');
c1 = c1.replace(/exports\.toggleMonthStatus = async \(req, res\) => \{[\s\S]*?\}\s*catch[^\}]+\}\s*\};\s*/g, '');
fs.writeFileSync('controllers/loans.js', c1);

let c2 = fs.readFileSync('routes/loans.js', 'utf8');
c2 = c2.replace(/router\.post\('\/:id\/record-interest'.*?;\n?/g, '');
c2 = c2.replace(/router\.patch\('\/:id\/months\/:monthIndex'.*?;\n?/g, '');
fs.writeFileSync('routes/loans.js', c2);

let c3 = fs.readFileSync('models/Loan.js', 'utf8');
c3 = c3.replace(/monthsTracking: \[\s*\{[\s\S]*?\}\s*\],\n?/g, '');
fs.writeFileSync('models/Loan.js', c3);
