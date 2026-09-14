const fs = require('fs');
let c = fs.readFileSync('routes/loans.js', 'utf8');

if (!c.includes("requireFinancialEligibility")) {
    c = c.replace(
        "const { validateCreateLoan, validatePaymentAmount } = require('../middleware/validate');",
        "const { validateCreateLoan, validatePaymentAmount } = require('../middleware/validate');\nconst { requireFinancialEligibility } = require('../middleware/eligibilityGuard');"
    );
    
    // Protect endpoints
    c = c.replace(/router\.post\('\/', validateCreateLoan, createLoan\);/, "router.post('/', requireFinancialEligibility, validateCreateLoan, createLoan);");
    c = c.replace(/router\.post\('\/:id\/verify', financialLimiter, verifyLoan\);/, "router.post('/:id/verify', requireFinancialEligibility, financialLimiter, verifyLoan);");
    c = c.replace(/router\.post\('\/:id\/close', financialLimiter, closeLoan\);/, "router.post('/:id/close', requireFinancialEligibility, financialLimiter, closeLoan);");
    c = c.replace(/router\.post\('\/:id\/record-payment', /g, "router.post('/:id/record-payment', requireFinancialEligibility, ");
    c = c.replace(/router\.post\('\/:id\/add-credit', /g, "router.post('/:id/add-credit', requireFinancialEligibility, ");
}

fs.writeFileSync('routes/loans.js', c);
