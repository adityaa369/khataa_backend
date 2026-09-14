const fs = require('fs');
let content = fs.readFileSync('controllers/loans.js', 'utf8');

// 1. Remove V1 monthsTracking initialization in createLoan (lines ~137-143)
content = content.replace(
    /\n\s+const monthsTracking = \[\];\s*\n\s+for \(let i = 1; i <= durationMonths; i\+\+\) \{\s*\n\s+monthsTracking\.push\(\{[\s\S]*?\}\);\s*\n\s+\}\n/,
    '\n'
);

// 2. Remove monthsTracking field from Loan.create() call
content = content.replace(/,?\s*\n\s+monthsTracking\s*\n/, '\n');
content = content.replace(/,\s*monthsTracking/, '');

// 3. Remove entire toggleMonthStatus function
content = content.replace(
    /\/\/ @desc\s+Toggle month status[\s\S]*?exports\.toggleMonthStatus = async[\s\S]*?\};\n\n/,
    ''
);

fs.writeFileSync('controllers/loans.js', content);
console.log('monthsTracking + toggleMonthStatus removed.');
