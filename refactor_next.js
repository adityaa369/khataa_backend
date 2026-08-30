const fs = require('fs');

// 1. Update Phase4E_Injection_Audit.js to support next()
let audit = fs.readFileSync('tests/Phase4E_Injection_Audit.js', 'utf8');

const mockReqResReplacement = `async function mockReqRes(reqBody, reqParams, reqQuery, user) {
    const req = {
        body: reqBody || {},
        params: reqParams || {},
        query: reqQuery || {},
        user: user || { id: 'lender_id', phone: '9999999999', _id: 'lender_id' }
    };
    const res = {
        statusCode: 200,
        body: null,
        status: function(code) { this.statusCode = code; return this; },
        json: function(data) { this.body = data; return this; },
        send: function(data) { this.body = data; return this; }
    };
    const next = function(err) {
        if (err) {
            // Simulate the error middleware!
            const errorHandler = require('../middleware/errorHandler');
            errorHandler(err, req, res, () => {});
        }
    };
    return { req, res, next };
}`;

audit = audit.replace(/async function mockReqRes[\s\S]*?return \{ req, res \};\s*\}/, mockReqResReplacement);
for (let i = 1; i <= 5; i++) {
    audit = audit.replace(`const { req: req${i}, res: res${i} }`, `const { req: req${i}, res: res${i}, next: next${i} }`);
    audit = audit.replace(`await loansController.createLoan(req${i}, res${i})`, `await loansController.createLoan(req${i}, res${i}, next${i})`);
    audit = audit.replace(`await loansController.getRepaymentTimeline(req${i}, res${i})`, `await loansController.getRepaymentTimeline(req${i}, res${i}, next${i})`);
    audit = audit.replace(`await loansController.recordPayment(req${i}, res${i})`, `await loansController.recordPayment(req${i}, res${i}, next${i})`);
}

fs.writeFileSync('tests/Phase4E_Injection_Audit.js', audit);
console.log('Updated Phase4E_Injection_Audit.js');

// 2. Refactor controllers/loans.js to use next()
let loans = fs.readFileSync('controllers/loans.js', 'utf8');

// Replace all instances of `async (req, res) =>` with `async (req, res, next) =>`
loans = loans.replace(/exports\.([a-zA-Z0-9_]+) = async \(req, res\) =>/g, 'exports.$1 = async (req, res, next) =>');

// Replace all catch (err) blocks to just call next(err)
loans = loans.replace(/catch\s*\(\s*err\s*\)\s*\{[\s\S]*?\}/g, 'catch (err) { next(err); }');

// We need to keep the Firebase catch block intact if it was inline! But wait, does loans.js have inline catch blocks?
// Yes, there is `verifyFirebaseOtp` which is now extracted to `utils/fcm`. But wait, in controllers/loans.js:
// Wait, the catch blocks at the end of the exports usually look like `catch (err) { ... }`.
// Let's see if we messed up anything inside the `try`.
fs.writeFileSync('controllers/loans.js', loans);
console.log('Refactored controllers/loans.js');
