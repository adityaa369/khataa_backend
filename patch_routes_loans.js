const fs = require('fs');
let r = fs.readFileSync('routes/loans.js', 'utf8');
r = r.replace(/deleteLoan/g, 'cancelLoan');
r = r.replace(/router\.delete\('\/:id', cancelLoan\);/g, "router.post('/:id/cancel', requireFinancialEligibility, cancelLoan);");
fs.writeFileSync('routes/loans.js', r);
