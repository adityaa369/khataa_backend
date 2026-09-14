const fs = require('fs');

function updateFinancialLedgerService() {
    const file = 'services/FinancialLedgerService.js';
    let content = fs.readFileSync(file, 'utf8');

    const acceptLoanReplacement = `
    static async acceptLoan(loanId, actorId, intentId) {
        return this.withTransactionRetry(async (session) => {
            const loan = await Loan.findById(loanId).session(session);
            if (!loan) throw new Error('LOAN_NOT_FOUND');
            if (loan.status !== 'pending') throw new Error('LOAN_NOT_PENDING');
            if (loan.ledgerVersion === 2 && loan.principalOutstandingPaise > 0) {
                throw new Error('LOAN_ALREADY_INITIALIZED');
            }

            const initialPrincipalPaise = loan.amountPaise || 0;
            this.validateMonetaryInput(initialPrincipalPaise);

            // CREDIT TYPE VALIDATION & IMMUTABLE AGREEMENT SNAPSHOT
            const creditType = loan.loanType || 'HAND';
            let interestRateBps = loan.interestRate || 0; 
            let interestMethod = 'NONE';

            if (creditType === 'INTEREST') {
                if (interestRateBps < 0 || interestRateBps > 3600) {
                    throw new Error('VALIDATION_ERROR: Interest rate must be between 0 and 3600 bps');
                }
                if (!Number.isInteger(interestRateBps)) {
                    throw new Error('VALIDATION_ERROR: Interest rate must be an integer');
                }
                interestMethod = 'SIMPLE_ORIGINAL_PRINCIPAL';
            } else {
                interestRateBps = 0;
                interestMethod = 'NONE';
            }

            loan.agreementSnapshot = {
                creditType,
                expectedPrincipalPaise: initialPrincipalPaise,
                interestRateBps,
                interestMethod
            };

            return await this._commitMutation({
                loan,
                type: 'LOAN_CREATED',
                deltas: { principal: initialPrincipalPaise, interest: 0, fees: 0 },
                amountPaise: initialPrincipalPaise,
                actorId,
                effectiveAt: new Date(),
                intentId,
                targetState: 'active'
            }, session);
        });
    }`;

    // Regex replace acceptLoan
    content = content.replace(/static async acceptLoan\(loanId, actorId, intentId\) \{[\s\S]*?targetState: 'active'\n\s*\}, session\);\n\s*\}\);\n\s*\}/m, acceptLoanReplacement.trim());

    fs.writeFileSync(file, content);
    console.log("Updated FinancialLedgerService.js successfully.");
}

updateFinancialLedgerService();
