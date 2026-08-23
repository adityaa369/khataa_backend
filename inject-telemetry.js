const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'controllers', 'loans.js');
let code = fs.readFileSync(filePath, 'utf8');

if (!code.includes('trackFinancialEvent')) {
    code = code.replace(
        "const { invalidateLoanCache } = require('../middleware/cache');",
        "const { invalidateLoanCache } = require('../middleware/cache');\nconst { trackFinancialEvent, triggerAlert } = require('../utils/telemetry');\nconst { metrics } = require('../middleware/metrics');"
    );
}

// 1. In _handleCustomTransaction
code = code.replace(
    "await currentLoan.save({ session });",
    "await currentLoan.save({ session });\n            trackFinancialEvent('LOAN_PAYMENT_COMMITTED', { loanId: currentLoan._id, amountPaise });\n            metrics.financial.paymentsCommitted++;"
);

code = code.replace(
    "const amountPaise = Math.round(amount * 100);",
    "const amountPaise = Math.round(amount * 100);\n        trackFinancialEvent('LOAN_PAYMENT_STARTED', { actionType, amountPaise });\n        metrics.financial.paymentsAttempted++;"
);

code = code.replace(
    "throw new Error('OVERPAYMENT_PROHIBITED');",
    "triggerAlert('OVERPAYMENT_ATTEMPT', 'CRITICAL', { actionType, amountPaise });\n                    metrics.financial.paymentsRejected++;\n                    throw new Error('OVERPAYMENT_PROHIBITED');"
);

// 2. In createLoan
code = code.replace(
    "await newLoan.save({ session });",
    "await newLoan.save({ session });\n            trackFinancialEvent('LOAN_CREATED', { loanId: newLoan._id, amountPaise });"
);

// 3. In verifyLoan
code = code.replace(
    "loanRecord.status = 'active';",
    "loanRecord.status = 'active';\n            trackFinancialEvent('LOAN_ACCEPTED', { loanId: loanRecord._id });"
);

fs.writeFileSync(filePath, code);
console.log('Telemetry successfully injected into controllers/loans.js');
