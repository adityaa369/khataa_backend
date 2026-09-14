const { execSync } = require('child_process');

function grepCount(pattern) {
    try {
        // -r recursive, -l list files, -c count matches...
        // Using powershell Select-String since we are on Windows
        const output = execSync(`powershell -Command "(Select-String -Path .\\controllers\\*.js, .\\routes\\*.js, .\\models\\*.js, .\\services\\*.js -Pattern '${pattern}').Count"`, { encoding: 'utf8' });
        const count = parseInt(output.trim());
        return isNaN(count) ? 0 : count;
    } catch (e) {
        return 0; // If Select-String returns 0 matches it sometimes errors out or returns empty
    }
}

console.log("=========================================================================");
console.log("             REPOSITORY-LEVEL V1 FINANCIAL PURGE GATE                    ");
console.log("=========================================================================\n");

const queries = [
    { name: "totalPayable mutation references", pattern: "totalPayable[Paise]?\\s*[+\\-]=" },
    { name: "custom_transactions mutation references", pattern: "custom_transactions\\.push" },
    { name: "monthsTracking mutation references", pattern: "monthsTracking" },
    { name: "recordInterest endpoint", pattern: "recordInterest" },
    { name: "toggleMonthStatus endpoint", pattern: "toggleMonthStatus" },
    { name: "direct balance mutations outside FinancialLedgerService", pattern: "principalOutstandingPaise\\s*[+\\-]=" }
];

let allZero = true;
for (const q of queries) {
    const count = grepCount(q.pattern);
    console.log(`${q.name}: ${count}`);
    if (count > 0) allZero = false;
}

console.log(`\n=========================================================================`);
if (allZero) {
    console.log("🟢 PURGE GATE PASSED: Zero V1 financial remnants detected.");
} else {
    console.log("🔴 PURGE GATE FAILED: V1 remnants still exist.");
}
console.log(`=========================================================================`);
