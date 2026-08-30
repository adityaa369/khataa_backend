const fs = require('fs');

// 1. Patch FinancialLedgerService.js
let fls = fs.readFileSync('services/FinancialLedgerService.js', 'utf8');

const intentConsumptionLogic = `
            // Atomic Intent Consumption inside Financial Transaction
            if (intentId) {
                const TransactionIntent = require('../models/TransactionIntent');
                const intent = await TransactionIntent.findOneAndUpdate(
                    { intentId, status: 'PENDING', expiresAt: { $gt: new Date() } },
                    { status: 'CONSUMED' },
                    { session, new: true }
                );
                if (!intent) {
                    throw new Error('INTENT_INVALID_OR_CONSUMED: Intent was already consumed, expired, or invalid.');
                }
            }
`;

if (!fls.includes('INTENT_INVALID_OR_CONSUMED')) {
    fls = fls.replace(
        /(const loan = await Loan\.findById\(loanId\)\.session\(session\);\n\s*if \(!loan\) throw new Error\('LOAN_NOT_FOUND'\);\n)/g, 
        "$1" + intentConsumptionLogic
    );
    fs.writeFileSync('services/FinancialLedgerService.js', fls);
}

// 2. Patch controllers/loans.js
let ctrl = fs.readFileSync('controllers/loans.js', 'utf8');

// Replace amounts and remove manual intent.status = 'CONSUMED'
ctrl = ctrl.replace(
    /const amountPaise = Math\.round\(amount \* 100\);[\s\S]*?intent\.status = 'CONSUMED';\s*await intent\.save\(\);/gm,
    `const amountPaise = intent.payload.amountPaise;\n\n        if (verificationId && otp) {\n            const verificationResult = await verifyFirebaseOtp(verificationId, otp);\n            if (!verificationResult.success) return res.status(400).json({ success: false, message: verificationResult.message });\n        }`
);

ctrl = ctrl.replace(/intent\.status = 'CONSUMED';\s*await intent\.save\(\);/g, '');

fs.writeFileSync('controllers/loans.js', ctrl);
console.log("P0 Intent fixes applied to FLS and Controllers.");
