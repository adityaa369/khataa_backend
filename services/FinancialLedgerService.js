const Loan = require('../models/Loan');

class FinancialLedgerService {

    static async accrueInterest(loan, effectiveAt = new Date()) {
        if (!loan.principalOutstandingPaise) {
            return; // No principal to accrue on
        }

        if (loan.loanType === 'interest_credit' || loan.loanType === 'business_credit') {
            // These loan types accrue their entire duration's interest upfront, not daily.
            const hasUpfront = loan.transactions.some(t => t.type === 'interest_accrued' && t.note && t.note.includes('Upfront'));
            if (!hasUpfront) {
                let months = loan.durationMonths || 0;
                if (loan.durationType === 'Days') {
                    months = months / 30.0;
                }
                const ratePct = loan.interestRate || 0;
                const amountPaise = loan.amountPaise || loan.principalOutstandingPaise;
                const totalInterestPaise = Math.floor((amountPaise * ratePct * months) / 100);
                if (totalInterestPaise > 0) {
                    loan.transactions.push({
                        type: 'interest_accrued',
                        amountPaise: totalInterestPaise,
                        interestAllocationPaise: totalInterestPaise,
                        note: `Upfront interest accrued for ${loan.durationMonths} ${loan.durationType || 'months'}`,
                        recordedAt: new Date(),
                        effectiveAt: loan.activatedAt || loan.startDate || new Date()
                    });
                    this.deriveBalances(loan);
                }
            }
            return;
        }

        // 1. Determine last accrual or activation date
        const lastAccrualOrActivation = loan.transactions
            .filter(t => ['interest_accrued', 'loan_given', 'credit_added'].includes(t.type))
            .map(t => t.effectiveAt || t.recordedAt)
            .sort((a, b) => b - a)[0] || loan.activatedAt || loan.startDate;

        if (!lastAccrualOrActivation) return; // Not active yet

        // 2. Calculate days elapsed
        const msPerDay = 1000 * 60 * 60 * 24;
        const daysElapsed = Math.floor((effectiveAt - lastAccrualOrActivation) / msPerDay);

        if (daysElapsed <= 0) return; // No days elapsed

        // 3. ACT/365 Exact Calculation
        // annualRate = monthlyRate * 12
        // dailyInterest = P * annualRate / 365
        // exact: floor( (P * rate * 12 * days) / (365 * 100) )
        // Note: loan.interestRate is a percentage e.g. 2 for 2%
        const ratePct = loan.interestRate || 0;
        if (ratePct <= 0) return;

        const principalPaise = loan.principalOutstandingPaise;
        const interestPaise = Math.floor((principalPaise * ratePct * 12 * daysElapsed) / (365 * 100));

        if (interestPaise > 0) {
            loan.transactions.push({
                type: 'interest_accrued',
                amountPaise: interestPaise,
                interestAllocationPaise: interestPaise,
                note: `Interest accrued for ${daysElapsed} days`,
                recordedAt: new Date(),
                effectiveAt: effectiveAt
            });
            this.deriveBalances(loan);
        }
    }

    static deriveBalances(loan) {
        let principal = 0;
        let interest = 0;
        let fees = 0;
        let paid = 0;

        // Replay all transactions
        const sortedTxns = [...loan.transactions].sort((a, b) => {
            const dateA = a.effectiveAt || a.recordedAt;
            const dateB = b.effectiveAt || b.recordedAt;
            return dateA - dateB;
        });

        for (const t of sortedTxns) {
            const amt = t.amountPaise || 0;
            switch(t.type) {
                case 'loan_given':
                case 'credit_added':
                    principal += amt;
                    break;
                case 'interest_accrued':
                    interest += amt;
                    break;
                case 'payment':
                case 'interest_payment':
                    paid += amt;
                    const fAlloc = t.feesAllocationPaise || 0;
                    const iAlloc = t.interestAllocationPaise || 0;
                    const pAlloc = t.principalAllocationPaise || 0;
                    fees -= fAlloc;
                    interest -= iAlloc;
                    principal -= pAlloc;
                    break;
            }
        }

        // Prevent negative balances
        loan.principalOutstandingPaise = Math.max(0, principal);
        loan.interestOutstandingPaise = Math.max(0, interest);
        loan.feesOutstandingPaise = Math.max(0, fees);
        loan.paidAmountPaise = paid;
        loan.totalPayablePaise = loan.principalOutstandingPaise + loan.interestOutstandingPaise + loan.feesOutstandingPaise;
        
        // Update legacy fields for compatibility
        loan.totalPayable = loan.totalPayablePaise / 100.0;
        loan.paidAmount = loan.paidAmountPaise / 100.0;
    }

    static async recordPayment(loan, amountPaise, intentId, recordedBy, effectiveAt = new Date(), paymentType = null) {
        if (!loan.transactions.some(t => t.type === 'loan_given')) {
            throw new Error('Cannot process V2 payment: Loan requires legacy reconciliation/migration first.');
        }
        // Idempotency check
        if (intentId && loan.transactions.some(t => t.intentId === intentId)) {
            return loan; // Already applied
        }

        // Accrue interest up to effective date
        await this.accrueInterest(loan, effectiveAt);

        // Overpayment check
        const totalOutstanding = loan.principalOutstandingPaise + loan.interestOutstandingPaise + loan.feesOutstandingPaise;
        if (amountPaise > totalOutstanding) {
            throw new Error(`Overpayment rejected. Amount: ${amountPaise}, Outstanding: ${totalOutstanding}`);
        }

        let remaining = amountPaise;
        let fAlloc = 0;
        let iAlloc = 0;
        let pAlloc = 0;
        
        const isInterestLoan = loan.type === 'interest_credit' || loan.type === 'interest';

        if (isInterestLoan && paymentType === 'interest') {
            iAlloc = Math.min(amountPaise, loan.interestOutstandingPaise);
            remaining = amountPaise - iAlloc;
        } else if (isInterestLoan && paymentType === 'principal') {
            pAlloc = Math.min(amountPaise, loan.principalOutstandingPaise);
            remaining = amountPaise - pAlloc;
        }

        // Waterfall allocation for whatever is remaining
        if (remaining > 0 && loan.feesOutstandingPaise > 0) {
            const fAllowed = loan.feesOutstandingPaise - fAlloc;
            const extraF = Math.min(remaining, fAllowed);
            fAlloc += extraF;
            remaining -= extraF;
        }
        if (remaining > 0 && loan.interestOutstandingPaise > 0) {
            const iAllowed = loan.interestOutstandingPaise - iAlloc;
            const extraI = Math.min(remaining, iAllowed);
            iAlloc += extraI;
            remaining -= extraI;
        }
        if (remaining > 0 && loan.principalOutstandingPaise > 0) {
            const pAllowed = loan.principalOutstandingPaise - pAlloc;
            const extraP = Math.min(remaining, pAllowed);
            pAlloc += extraP;
            remaining -= extraP;
        }

        loan.transactions.push({
            type: 'payment',
            amountPaise: amountPaise,
            feesAllocationPaise: fAlloc,
            interestAllocationPaise: iAlloc,
            principalAllocationPaise: pAlloc,
            note: 'Principal/Interest payment recorded',
            recordedAt: new Date(),
            effectiveAt: effectiveAt,
            recordedBy: recordedBy,
            intentId: intentId
        });

        this.deriveBalances(loan);
        
        if (loan.totalPayablePaise <= 0) {
            loan.status = 'completed';
            loan.progress = 1.0;
        }

        return loan;
    }

    static async addCredit(loan, amountPaise, intentId, recordedBy, effectiveAt = new Date()) {
        if (!loan.transactions.some(t => t.type === 'loan_given')) {
            throw new Error('Cannot process V2 credit: Loan requires legacy reconciliation/migration first.');
        }
        // Idempotency check
        if (intentId && loan.transactions.some(t => t.intentId === intentId)) {
            return loan; // Already applied
        }

        // Accrue interest up to effective date BEFORE credit
        await this.accrueInterest(loan, effectiveAt);

        loan.transactions.push({
            type: 'credit_added',
            amountPaise: amountPaise,
            note: 'Credit added by lender',
            recordedAt: new Date(),
            effectiveAt: effectiveAt,
            recordedBy: recordedBy,
            intentId: intentId
        });

        this.deriveBalances(loan);
        return loan;
    }

    static async activateLoan(loan, amountPaise, recordedBy, effectiveAt = new Date()) {
        // Opening transaction (Idempotency check: only if no loan_given transaction exists)
        if (!loan.transactions.some(t => t.type === 'loan_given')) {
            loan.transactions.push({
                type: 'loan_given',
                amountPaise: amountPaise,
                note: 'Loan Activated',
                recordedAt: new Date(),
                effectiveAt: effectiveAt,
                recordedBy: recordedBy
            });
            loan.amountPaise = amountPaise;
            this.deriveBalances(loan);
            
            // Accrue upfront interest immediately if applicable
            await this.accrueInterest(loan, effectiveAt);
        }
        return loan;
    }

    static async closeLoan(loan, effectiveAt = new Date()) {
        if (!loan.transactions.some(t => t.type === 'loan_given')) {
            throw new Error('Cannot close loan: Requires legacy reconciliation/migration first.');
        }

        // Accrue final interest
        await this.accrueInterest(loan, effectiveAt);

        // Derive balances from V2 ledger
        this.deriveBalances(loan);

        // Verify zero outstanding
        if (loan.principalOutstandingPaise > 0 || loan.interestOutstandingPaise > 0 || loan.feesOutstandingPaise > 0) {
            throw new Error(`Cannot close loan: Outstanding balance exists. Principal: ${loan.principalOutstandingPaise}, Interest: ${loan.interestOutstandingPaise}, Fees: ${loan.feesOutstandingPaise}`);
        }

        return loan;
    }
}

module.exports = FinancialLedgerService;
