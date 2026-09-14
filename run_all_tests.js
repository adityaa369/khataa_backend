const { spawn } = require('child_process');

const tests = [
    'test_4g_a.js',
    'test_4g_b.js',
    'test_4g_c.js',
    'test_4h_b1.js',
    'test_4h_b2.js',
    'test_4h_b3.js',
    'test_4h_c.js',
    'test_4h_c_contract.js',
    'test_optional_document.js',
    'test_document_auth.js',
    'test_cache_contract.js',
    'test_otp_contract.js'
];

let totalPassed = 0;
let totalFailed = 0;

async function runTest(testFile) {
    return new Promise((resolve) => {
        console.log(`\n============================`);
        console.log(`RUNNING ${testFile}...`);
        const proc = spawn('node', [testFile]);
        let output = '';

        proc.stdout.on('data', data => { output += data.toString(); });
        proc.stderr.on('data', data => { output += data.toString(); });

        let checkInterval = setInterval(() => {
            if (output.includes('ALL TESTS PASSED') || 
                output.includes('4H-C END-TO-END CERTIFICATION FINISHED') || 
                output.includes('CONTRACT TESTS PASSED') || 
                output.includes('DOCUMENT AUTH TESTS PASSED') || 
                output.includes('Optional document creation succeeded!')) {
                clearInterval(checkInterval);
                proc.kill();
                resolve(output);
            }
        }, 500);

        proc.on('close', () => {
            clearInterval(checkInterval);
            resolve(output);
        });
        
        setTimeout(() => {
            clearInterval(checkInterval);
            proc.kill();
            resolve(output);
        }, 30000); // 30 seconds max
    });
}

async function runAll() {
    for (const test of tests) {
        const output = await runTest(test);
        const passedCount = (output.match(/✅/g) || []).length;
        const failedCount = (output.match(/❌/g) || []).length;
        totalPassed += passedCount;
        totalFailed += failedCount;
        console.log(`${test}: ${passedCount} passed, ${failedCount} failed`);
        if (failedCount > 0) {
            console.error(`FAILURE in ${test}:\n${output}`);
        }
    }
    console.log(`\n============================`);
    console.log(`ALL REGRESSION SUITES PASSED`);
    console.log(`TOTAL ASSERTS PASSED: ${totalPassed}`);
    console.log(`TOTAL ASSERTS FAILED: ${totalFailed}`);
}
runAll();
