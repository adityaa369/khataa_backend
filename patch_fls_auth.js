const fs = require('fs');

const file = 'services/FinancialLedgerService.js';
let content = fs.readFileSync(file, 'utf8');

// Function to add authorization check to service methods
function patchAuthGuard(methodName, isBorrowerAction = false) {
    const authCheck = isBorrowerAction 
        ? `if (loan.borrower.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only borrower can perform this');\n            `
        : `if (loan.lender.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only lender can perform this');\n            `;

    const regex = new RegExp(`(static async ${methodName}\\([\\s\\S]*?const loan = await Loan\\.findById\\(loanId\\)\\.session\\(session\\);\\n\\s*if \\(!loan\\) throw new Error\\('LOAN_NOT_FOUND'\\);\\n\\s*)`);
    content = content.replace(regex, `$1${authCheck}`);
}

patchAuthGuard('acceptLoan', true); // Borrower
patchAuthGuard('addCredit', false); // Lender
patchAuthGuard('recordPayment', false); // Lender
patchAuthGuard('writeOffAndClose', false); // Lender
patchAuthGuard('reverseTransaction', false); // Lender

fs.writeFileSync(file, content);
console.log("FinancialLedgerService patched with authorization guards.");
