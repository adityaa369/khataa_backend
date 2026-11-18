const Loan = require('../models/Loan');

class FinancialLedgerService {

    static computeExpectedInterestPaise(loan) {
        const lType = String(loan.loanType || loan.type || '').toLowerCase();
        if (!lType.includes('interest') && !lType.includes('home')) {
            return 0;
        }
        const ratePct = Number(loan.interestRate || 0);
        if (ratePct <= 0) return 0;

        const baseAmountPaise = loan.amountPaise != null
            ? Number(loan.amountPaise)
            : Math.round(Number(loan.amount || 0) * 100);
        if (baseAmountPaise <= 0) return 0;

        const isDays = String(loan.durationType || '').toLowerCase() === 'days';
        const rawDuration = Number(loan.durationMonths || 0);
        let months = isDays ? (rawDuration / 30.0) : rawDuration;
        // If start and end dates fall on exact calendar month boundaries (e.g. 18 Nov to 18 Jan = 61 days -> 2 months)
        if (isDays && rawDuration >= 28 && (rawDuration % 30 <= 2 || rawDuration % 30 >= 28)) {
            months = Math.max(1, Math.round(rawDuration / 30.0));
        }
        return Math.floor((baseAmountPaise * ratePct * months) / 100);
    }

    static async accrueInterest(loan, effectiveAt = new Date()) {
        const baseAmountPaise = loan.amountPaise != null
            ? Number(loan.amountPaise)
            : Math.round(Number(loan.amount || 0) * 100);
        if (!loan.principalOutstandingPaise && baseAmountPaise <= 0) {
            return; // No principal to accrue on
        }

        const lType = String(loan.loanType || loan.type || '').toLowerCase();
        if (lType === 'hand_credit' || lType === 'business_credit' || lType === 'personal' || lType === 'business') {
            return; // Hand Credit and Business Credit are strictly 0% interest ledgers
        }

        if (lType.includes('interest') || lType.includes('home')) {
            // Upfront interest for initial loan duration
            if (!Array.isArray(loan.transactions)) {
                loan.transactions = [];
            }
            const hasUpfront = loan.transactions.some(t => t.type === 'interest_accrued');
            if (!hasUpfront) {
                const totalInterestPaise = this.computeExpectedInterestPaise(loan);
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

        const txns = Array.isArray(loan.transactions) ? loan.transactions : [];
        const hasLoanGiven = txns.some(t => t.type === 'loan_given');
        const hasInterestAccrued = txns.some(t => t.type === 'interest_accrued');
        const baseAmountPaise = loan.amountPaise != null
            ? Number(loan.amountPaise)
            : Math.round(Number(loan.amount || 0) * 100);

        if (!hasLoanGiven && baseAmountPaise > 0) {
            principal += baseAmountPaise;
        }

        if (!hasInterestAccrued) {
            const expectedInterest = this.computeExpectedInterestPaise(loan);
            if (expectedInterest > 0) {
                interest += expectedInterest;
            }
        }

        // Replay all transactions
        const sortedTxns = [...txns].sort((a, b) => {
            const dateA = new Date(a.effectiveAt || a.recordedAt || 0).getTime();
            const dateB = new Date(b.effectiveAt || b.recordedAt || 0).getTime();
            return dateA - dateB;
        });

        for (const t of sortedTxns) {
            const amt = t.amountPaise != null
                ? Number(t.amountPaise)
                : Math.round(Number(t.amount || 0) * 100);
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
                    let fAlloc = Number(t.feesAllocationPaise || 0);
                    let iAlloc = Number(t.interestAllocationPaise || 0);
                    let pAlloc = Number(t.principalAllocationPaise || 0);
                    if (fAlloc === 0 && iAlloc === 0 && pAlloc === 0 && amt > 0) {
                        if (t.type === 'interest_payment') {
                            iAlloc = Math.min(amt, interest);
                            pAlloc = amt - iAlloc;
                        } else {
                            pAlloc = Math.min(amt, principal);
                            iAlloc = amt - pAlloc;
                        }
                    }
                    fees -= fAlloc;
                    interest -= iAlloc;
                    principal -= pAlloc;
                    break;
            }
        }

        // Prevent negative balances
        loan.amountPaise = baseAmountPaise;
        loan.principalOutstandingPaise = Math.max(0, principal);
        loan.interestOutstandingPaise = Math.max(0, interest);
        loan.feesOutstandingPaise = Math.max(0, fees);
        loan.paidAmountPaise = paid;
        loan.totalPayablePaise = loan.principalOutstandingPaise + loan.interestOutstandingPaise + loan.feesOutstandingPaise;
        
        // Update progress
        const totalOriginalPaise = loan.totalPayablePaise + loan.paidAmountPaise;
        if (totalOriginalPaise > 0) {
            loan.progress = Math.min(1.0, Math.max(0.0, loan.paidAmountPaise / totalOriginalPaise));
        } else {
            loan.progress = 0.0;
        }
        if (loan.totalPayablePaise <= 0 && loan.paidAmountPaise > 0) {
            loan.progress = 1.0;
        }

        // Update legacy fields for compatibility
        loan.totalPayable = loan.totalPayablePaise / 100.0;
        loan.paidAmount = loan.paidAmountPaise / 100.0;
    }

    static async reconcileLoan(loan) {
        let modified = false;
        const mongoose = require('mongoose');
        const User = require('../models/User');

        // Self-heal lender/borrower if Mongoose .populate() + .save() ever overwrote User.id with User._id
        if (loan.lender && typeof loan.lender === 'string' && mongoose.Types.ObjectId.isValid(loan.lender) && loan.lender.length === 24) {
            const uById = await User.findOne({ id: loan.lender }).select('id').lean();
            if (!uById) {
                const uByObjId = await User.findById(loan.lender).select('id').lean();
                if (uByObjId && uByObjId.id) {
                    loan.lender = uByObjId.id;
                    modified = true;
                }
            }
        }
        if (loan.borrower && typeof loan.borrower === 'string' && mongoose.Types.ObjectId.isValid(loan.borrower) && loan.borrower.length === 24) {
            const bById = await User.findOne({ id: loan.borrower }).select('id').lean();
            if (!bById) {
                const bByObjId = await User.findById(loan.borrower).select('id').lean();
                if (bByObjId && bByObjId.id) {
                    loan.borrower = bByObjId.id;
                    modified = true;
                }
            }
        }

        // Self-heal missing endDate
        if (!loan.endDate && (loan.startDate || loan.createdAt) && loan.durationMonths) {
            const start = new Date(loan.startDate || loan.createdAt);
            const end = new Date(start);
            if (String(loan.durationType || '').toLowerCase() === 'days') {
                end.setDate(end.getDate() + Number(loan.durationMonths || 30));
            } else {
                end.setMonth(end.getMonth() + Number(loan.durationMonths || 1));
            }
            loan.endDate = end;
            modified = true;
        }

        if (!Array.isArray(loan.transactions)) {
            loan.transactions = [];
            modified = true;
        }

        const baseAmountPaise = loan.amountPaise != null
            ? Number(loan.amountPaise)
            : Math.round(Number(loan.amount || 0) * 100);
        if (loan.amountPaise !== baseAmountPaise && baseAmountPaise > 0) {
            loan.amountPaise = baseAmountPaise;
            modified = true;
        }

        // Deduplicate upfront interest if race condition caused multiple inserts
        const upfrontTxns = loan.transactions.filter(t => t.type === 'interest_accrued' && t.note && t.note.includes('Upfront'));
        if (upfrontTxns.length > 1) {
            const firstUpfrontId = upfrontTxns[0]._id;
            loan.transactions = loan.transactions.filter(t =>
                !(t.type === 'interest_accrued' && t.note && t.note.includes('Upfront') && t._id.toString() !== firstUpfrontId.toString())
            );
            modified = true;
        }

        const isPendingOrRejected = ['pending_approval', 'pending_otp', 'rejected', 'cancelled', 'expired'].includes(loan.status);
        if (!isPendingOrRejected) {
            if (!loan.transactions.some(t => t.type === 'loan_given') && baseAmountPaise > 0) {
                loan.transactions.push({
                    type: 'loan_given',
                    amountPaise: baseAmountPaise,
                    note: 'Loan Activated',
                    recordedAt: loan.activatedAt || loan.startDate || loan.createdAt || new Date(),
                    effectiveAt: loan.activatedAt || loan.startDate || loan.createdAt || new Date(),
                    recordedBy: loan.borrower || loan.lender
                });
                modified = true;
            }

            const lType = String(loan.loanType || loan.type || '').toLowerCase();
            if ((lType.includes('interest') || lType.includes('home')) && Number(loan.interestRate || 0) > 0) {
                const hasInterestTxn = loan.transactions.some(t => t.type === 'interest_accrued');
                if (!hasInterestTxn) {
                    await this.accrueInterest(loan);
                    modified = true;
                } else {
                    // Check if existing upfront interest txn aligns with computeExpectedInterestPaise
                    const expectedInterest = this.computeExpectedInterestPaise(loan);
                    const upfrontTxn = loan.transactions.find(t => t.type === 'interest_accrued');
                    if (upfrontTxn && (!upfrontTxn.amountPaise || upfrontTxn.amountPaise <= 0) && expectedInterest > 0) {
                        upfrontTxn.amountPaise = expectedInterest;
                        upfrontTxn.interestAllocationPaise = expectedInterest;
                        modified = true;
                    }
                }
            }
        }

        const prevPrincipal = loan.principalOutstandingPaise;
        const prevInterest = loan.interestOutstandingPaise;
        const prevTotal = loan.totalPayablePaise;
        this.deriveBalances(loan);

        if (
            prevPrincipal !== loan.principalOutstandingPaise ||
            prevInterest !== loan.interestOutstandingPaise ||
            prevTotal !== loan.totalPayablePaise
        ) {
            modified = true;
        }

        if (modified && typeof loan.save === 'function') {
            await loan.save();
        }
        return loan;
    }

    static async recordPayment(loan, amountPaise, intentId, recordedBy, effectiveAt = new Date(), paymentType = null) {
        if (!loan.transactions.some(t => t.type === 'loan_given')) {
            await this.activateLoan(
                loan,
                loan.amountPaise || Math.round((loan.amount || 0) * 100),
                loan.lender,
                loan.activatedAt || loan.startDate || loan.createdAt || effectiveAt
            );
        }
        // Idempotency check
        if (intentId && loan.transactions.some(t => t.intentId === intentId)) {
            return loan; // Already applied
        }

        // Accrue interest up to effective date
        await this.accrueInterest(loan, effectiveAt);

        const loanTypeStr = (loan.loanType || loan.type || '').toLowerCase();
        const isInterestLoan = loanTypeStr.includes('interest') || loanTypeStr.includes('home');
        const totalOutstanding = (loan.principalOutstandingPaise || 0) + (loan.interestOutstandingPaise || 0) + (loan.feesOutstandingPaise || 0);

        if (amountPaise > totalOutstanding) {
            throw new Error(`Overpayment rejected. Amount: ₹${(amountPaise / 100).toFixed(2)} exceeds remaining balance of ₹${(totalOutstanding / 100).toFixed(2)}`);
        }

        let fAlloc = 0;
        let iAlloc = 0;
        let pAlloc = 0;

        if (isInterestLoan && paymentType === 'interest') {
            // Allocate to interest first; if payment exceeds interest, apply remainder to principal
            iAlloc = Math.min(amountPaise, loan.interestOutstandingPaise || 0);
            const remAfterInterest = amountPaise - iAlloc;
            pAlloc = Math.min(remAfterInterest, loan.principalOutstandingPaise || 0);
            fAlloc = 0;
        } else if (isInterestLoan && paymentType === 'principal') {
            // Allocate to principal first; if payment exceeds principal (e.g. full settlement), apply remainder to interest
            pAlloc = Math.min(amountPaise, loan.principalOutstandingPaise || 0);
            const remAfterPrincipal = amountPaise - pAlloc;
            iAlloc = Math.min(remAfterPrincipal, loan.interestOutstandingPaise || 0);
            fAlloc = 0;
        } else {
            // Waterfall allocation for general payments or non-interest loans (hand/business)
            let remaining = amountPaise;
            if (remaining > 0 && loan.feesOutstandingPaise > 0) {
                fAlloc = Math.min(remaining, loan.feesOutstandingPaise);
                remaining -= fAlloc;
            }
            if (remaining > 0 && loan.interestOutstandingPaise > 0) {
                iAlloc = Math.min(remaining, loan.interestOutstandingPaise);
                remaining -= iAlloc;
            }
            if (remaining > 0 && loan.principalOutstandingPaise > 0) {
                pAlloc = Math.min(remaining, loan.principalOutstandingPaise);
                remaining -= pAlloc;
            }
        }

        loan.transactions.push({
            type: paymentType === 'interest' ? 'interest_payment' : 'payment',
            amountPaise: amountPaise,
            feesAllocationPaise: fAlloc,
            interestAllocationPaise: iAlloc,
            principalAllocationPaise: pAlloc,
            note: paymentType === 'interest'
                ? 'Interest payment recorded'
                : (paymentType === 'principal' ? 'Principal payment recorded' : 'Principal/Interest payment recorded'),
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
            await this.activateLoan(
                loan,
                loan.amountPaise || Math.round((loan.amount || 0) * 100),
                loan.lender,
                loan.activatedAt || loan.startDate || loan.createdAt || effectiveAt
            );
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

    static async closeLoan(loan, effectiveAt = new Date(), recordedBy = null, intentId = null) {
        if (!loan.transactions.some(t => t.type === 'loan_given')) {
            await this.activateLoan(
                loan,
                loan.amountPaise || Math.round((loan.amount || 0) * 100),
                loan.lender,
                loan.activatedAt || loan.startDate || loan.createdAt || effectiveAt
            );
        }

        // Accrue final interest
        await this.accrueInterest(loan, effectiveAt);

        // Derive balances from V2 ledger
        this.deriveBalances(loan);

        // If any outstanding balance remains, record a mutual settlement/waiver entry so closure succeeds cleanly
        const remainingPrincipal = loan.principalOutstandingPaise || 0;
        const remainingInterest = loan.interestOutstandingPaise || 0;
        const remainingFees = loan.feesOutstandingPaise || 0;
        const totalRemaining = remainingPrincipal + remainingInterest + remainingFees;

        if (totalRemaining > 0) {
            loan.transactions.push({
                type: 'payment',
                amountPaise: totalRemaining,
                principalAllocationPaise: remainingPrincipal,
                interestAllocationPaise: remainingInterest,
                feesAllocationPaise: remainingFees,
                note: 'Mutual credit closure & balance settlement',
                recordedAt: new Date(),
                effectiveAt: effectiveAt,
                recordedBy: recordedBy || loan.lender,
                intentId: intentId || ('close_settlement_' + Date.now())
            });
            this.deriveBalances(loan);
        }

        loan.status = 'closed';
        loan.progress = 1.0;

        return loan;
    }
}

module.exports = FinancialLedgerService;
