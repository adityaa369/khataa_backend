const { execSync } = require('child_process');
const tests = [
    'tests/Phase2_Verification.js',
    'tests/Phase3_Verification.js',
    'tests/Phase4_HandBusinessCredit_API.js',
    'tests/Phase4B_InterestCredit_API.js',
    'tests/Phase4E_P1_FirebaseIdentity_Regression.js'
];

for (const test of tests) {
    console.log(`\n\n--- Running ${test} ---`);
    try {
        const output = execSync(`node ${test}`, { encoding: 'utf-8', stdio: 'inherit' });
    } catch (e) {
        console.error(`\n❌ Failed: ${test}`);
        process.exit(1);
    }
}
console.log('\n\n✅ ALL REGRESSION SUITES PASSED');
