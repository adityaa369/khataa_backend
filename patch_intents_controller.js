const fs = require("fs");
let code = fs.readFileSync("controllers/intents.js", "utf8");

let startIdx = code.indexOf("// 3. Loan State & FinancialStatus validation");
let endIdx = code.indexOf("// 4. Create Intent");

let newValidationCode = `// 3. Loan State & FinancialStatus validation
        if (action === 'ACCEPT_LOAN' && loan.status !== 'pending_approval') {
            return res.status(409).json({
                success: false,
                code: 'LOAN_NOT_PENDING_APPROVAL',
                message: 'This loan is no longer awaiting borrower acceptance.'
            });
        }
        if (loan.status === 'frozen') {
            return res.status(400).json({ success: false, code: 'MUTATION_REJECTED', message: 'Loan is frozen' });
        }
        if (['closed', 'completed', 'rejected', 'cancelled', 'expired'].includes(loan.status) && action !== 'REVERSE') {
            return res.status(400).json({ success: false, code: 'MUTATION_REJECTED', message: 'Loan is in terminal state' });
        }
        
        `;

code = code.substring(0, startIdx) + newValidationCode + code.substring(endIdx);
fs.writeFileSync("controllers/intents.js", code);

