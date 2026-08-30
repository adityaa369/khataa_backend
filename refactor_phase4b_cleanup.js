const fs = require('fs');

function replaceInFile(filePath, replacements) {
    let content = fs.readFileSync(filePath, 'utf8');
    for (const { pattern, replacement } of replacements) {
        content = content.replace(pattern, replacement);
    }
    fs.writeFileSync(filePath, content);
    console.log(`Updated ${filePath}`);
}

// 1. Clean routes/loans.js
replaceInFile('routes/loans.js', [
    { pattern: /recordInterest,\s*/g, replacement: '' },
    { pattern: /toggleMonthStatus,\s*/g, replacement: '' },
    { pattern: /router\.post\('\/:id\/record-interest', [^\)]+\);\n/g, replacement: '' },
    { pattern: /router\.patch\('\/:id\/months\/:monthIndex', [^\)]+\);\n/g, replacement: '' }
]);

// 2. Clean controllers/loans.js
// Remove toggleMonthStatus entirely
replaceInFile('controllers/loans.js', [
    { pattern: /exports\.toggleMonthStatus = async \(req, res\) => \{[\s\S]*?\n\};\n\n/g, replacement: '' }
]);

// 3. Clean models/Loan.js
// Remove totalPayable, totalPayablePaise, custom_transactions, monthsTracking
replaceInFile('models/Loan.js', [
    { pattern: /totalPayable: \{ type: Number, default: 0 \},\n/g, replacement: '' },
    { pattern: /totalPayablePaise: \{ type: Number, validate: \{ validator: Number.isInteger \}, default: 0 \},\n/g, replacement: '' },
    { pattern: /monthsTracking: \[\s*\{\s*monthIndex: Number,\s*status: \{ type: String, enum: \['paid', 'unpaid', 'overdue'\], default: 'unpaid' \},\s*markedPaidAt: Date,\s*markedBy: String\s*\}\s*\],\n/g, replacement: '' },
    // Also, inject agreementSnapshot into the schema if not there
    { 
        pattern: /ledgerVersion: \{ type: Number, default: 1 \},/g, 
        replacement: `ledgerVersion: { type: Number, default: 1 },\n    agreementSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },` 
    }
]);

// 4. Clean controllers/admin.js
replaceInFile('controllers/admin.js', [
    { 
        pattern: /\{ \$group: \{ _id: null, totalOutstandingPaise: \{ \$sum: \{ \$subtract: \["\$totalPayablePaise", "\$paidAmountPaise"\] \} \} \} \}/g, 
        replacement: `{ $group: { _id: null, totalOutstandingPaise: { $sum: { $add: ["$principalOutstandingPaise", "$interestOutstandingPaise", "$feesOutstandingPaise"] } } } }` 
    }
]);

// 5. Clean controllers/adminFinancialExplorer.js
replaceInFile('controllers/adminFinancialExplorer.js', [
    {
        pattern: /totalPayablePaise: \{\s*\$cond: \[\{ \$eq: \["\$status", "active"\] \}, "\$totalPayablePaise", 0\]\s*\}/g,
        replacement: `totalPayablePaise: { 
                            $cond: [{ $eq: ["$status", "active"] }, { $add: ["$principalOutstandingPaise", "$interestOutstandingPaise", "$feesOutstandingPaise"] }, 0] 
                        }`
    },
    {
        pattern: /activeLoanTotalPayablePaise = s\.totalPayablePaise;/g,
        replacement: `activeLoanTotalPayablePaise = s.principalOutstandingPaise + s.interestOutstandingPaise + s.feesOutstandingPaise;`
    }
]);

// 6. Clean services/ReconciliationService.js
replaceInFile('services/ReconciliationService.js', [
    {
        pattern: /if \(\!Number\.isInteger\(loan\.totalPayablePaise\) \|\| loan\.totalPayablePaise < 0\) \{[\s\S]*?Overpayment detected'\);\n\s*\}/g,
        replacement: `// Replaced by V2 independent reconciliation`
    }
]);

console.log("Phase 4B surgical cleanup executed successfully.");
