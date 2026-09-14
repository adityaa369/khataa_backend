const fs = require('fs');
let c = fs.readFileSync('controllers/loans.js', 'utf8');

c = c.replace(/if \(!verificationId\) \{[\s\S]*?\}\n/g, '');

fs.writeFileSync('controllers/loans.js', c);
console.log('Fixed controllers/loans.js');
