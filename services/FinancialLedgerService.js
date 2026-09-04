const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Loan = require('../models/Loan');

class FinancialLedgerService {

    static async withTransactionRetry(action) {
        let attempts = 0;
        const maxAttempts = 5;
        
        while (attempts < maxAttempts) {
            attempts++;
            const session = await mongoose.startSession();
            try {
                let capturedResult;
                await session.withTransaction(async (txnSession) => {
                    capturedResult = await action(txnSession);
                });
                return capturedResult;
            } catch (error) {
                const isTransient = error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError');
                const isDuplicateSequence = error.code === 11000 && error.message.includes('sequenceNumber');
                
                if (isTransient || isDuplicateSequence) {
                    if (attempts >= maxAttempts) throw error;
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempts) * 50));
                    continue;
                }
                throw error;
            } finally {
                session.endSession();
            }
        }
    }

    static validateMonetaryInput(amountPaise) {
        if (!Number.isInteger(amountPaise)) throw new Error('VALIDATION_ERROR: Amount must be an integer');
        if (amountPaise <= 0) throw new Error('VALIDATION_ERROR: Amount must be greater than zero');
        if (amountPaise > Number.MAX_SAFE_INTEGER) throw new Error('VALIDATION_ERROR: Amount exceeds safe integer limits');
        const MAX_BUSINESS_LOAN_PAISE = 1000000000;
        if (amountPaise > MAX_BUSINESS_LOAN_PAISE) throw new Error('VALIDATION_ERROR: Amount exceeds business limits');
    }

    // ==========================================
    // LEVEL 2: TYPED BUSINESS OPERATIONS
    // ==========================================

    static async acceptLoan(loanId, actorId, intentId) {
        return this.withTransactionRetry(async (session) => {
            const loan = await Loan.findById(loanId).session(session);
            if (!loan) throw new Error('LOAN_NOT_FOUND');

            if (loan.borrower.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only borrower can perform this');
            // Atomic Intent Consumption inside Financial Transaction
            if (intentId) {
                const TransactionIntent = require('../models/TransactionIntent');
                const intent = await TransactionIntent.findOneAndUpdate(
                    { intentId, status: 'PENDING', expiresAt: { $gt: new Date() } },
                    { status: 'CONSUMED' },
                    { session, new: true }
                );
                if (!intent) {
                    throw new Error('INTENT_INVALID_OR_CONSUMED: Intent was already consumed, expired, or invalid.');
                }
            }
            if (loan.borrower.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only borrower can perform this');
            if (loan.status !== 'pending_approval') throw new Error('LOAN_NOT_PENDING');
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
                targetState: 'active',
                notification: {
                    recipientId: loan.lender,
                    eventType: 'LOAN_ACCEPTED',
                    title: 'Loan Accepted',
                    body: `The borrower has accepted the loan of ₹${(initialPrincipalPaise / 100).toFixed(2)}.`
                }
            }, session);
        });
    }

    static async addCredit(loanId, additionalPrincipalPaise, actorId, intentId) {
        this.validateMonetaryInput(additionalPrincipalPaise);
        return this.withTransactionRetry(async (session) => {
            const loan = await Loan.findById(loanId).session(session);
            if (!loan) throw new Error('LOAN_NOT_FOUND');

            if (loan.lender.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only lender can perform this');
            // Atomic Intent Consumption inside Financial Transaction
            if (intentId) {
                const TransactionIntent = require('../models/TransactionIntent');
                const intent = await TransactionIntent.findOneAndUpdate(
                    { intentId, status: 'PENDING', expiresAt: { $gt: new Date() } },
                    { status: 'CONSUMED' },
                    { session, new: true }
                );
                if (!intent) {
                    throw new Error('INTENT_INVALID_OR_CONSUMED: Intent was already consumed, expired, or invalid.');
                }
            }
            if (loan.lender.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only lender can perform this');
            if (loan.status !== 'active') throw new Error('LOAN_NOT_ACTIVE');

            return await this._commitMutation({
                loan,
                type: 'CREDIT_ADDED',
                deltas: { principal: additionalPrincipalPaise, interest: 0, fees: 0 },
                amountPaise: additionalPrincipalPaise,
                actorId,
                effectiveAt: new Date(),
                intentId,
                notification: {
                    recipientId: loan.borrower,
                    eventType: 'CREDIT_ADDED',
                    title: 'Credit Added',
                    body: `Your lender added a credit of ₹${(additionalPrincipalPaise / 100).toFixed(2)}.`
                }
            }, session);
        });
    }

    static async recordPayment(loanId, paymentAmountPaise, actorId, intentId) {
        this.validateMonetaryInput(paymentAmountPaise);
        return this.withTransactionRetry(async (session) => {
            const loan = await Loan.findById(loanId).session(session);
            if (!loan) throw new Error('LOAN_NOT_FOUND');
            
            // Legacy V1 Migration
            if ((loan.ledgerVersion || 1) < 2) {
                loan.principalOutstandingPaise = loan.amountPaise - (loan.paidAmountPaise || 0);
                loan.interestOutstandingPaise = 0;
                loan.feesOutstandingPaise = 0;
                loan.ledgerVersion = 2;
                await loan.save({ session });
            }

            if (loan.lender.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only lender can perform this');
            // Atomic Intent Consumption inside Financial Transaction
            if (intentId) {
                const TransactionIntent = require('../models/TransactionIntent');
                const intent = await TransactionIntent.findOneAndUpdate(
                    { intentId, status: 'PENDING', expiresAt: { $gt: new Date() } },
                    { status: 'CONSUMED' },
                    { session, new: true }
                );
                if (!intent) {
                    throw new Error('INTENT_INVALID_OR_CONSUMED: Intent was already consumed, expired, or invalid.');
                }
            }

            if (loan.lender.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only lender can perform this');
            let remaining = paymentAmountPaise;
            
            const feeAlloc = Math.min(remaining, loan.feesOutstandingPaise);
            remaining -= feeAlloc;
            
            const intAlloc = Math.min(remaining, loan.interestOutstandingPaise);
            remaining -= intAlloc;
            
            const pAlloc = Math.min(remaining, loan.principalOutstandingPaise);
            remaining -= pAlloc;

            if (remaining > 0) {
                throw new Error('OVERPAYMENT_REJECTED: Amount exceeds outstanding debt');
            }

            return await this._commitMutation({
                loan,
                type: 'PAYMENT',
                deltas: { principal: pAlloc * -1, interest: intAlloc * -1, fees: feeAlloc * -1 },
                amountPaise: paymentAmountPaise,
                actorId,
                effectiveAt: new Date(),
                intentId,
                notification: {
                    recipientId: loan.borrower,
                    eventType: 'PAYMENT_COMMITTED',
                    title: 'Payment Recorded',
                    body: `Your lender recorded a payment of ₹${(paymentAmountPaise / 100).toFixed(2)}.`
                }
            }, session);
        });
    }

    static async writeOffAndClose(loanId, actorId, intentId) {
        return this.withTransactionRetry(async (session) => {
            const loan = await Loan.findById(loanId).session(session);
            if (!loan) throw new Error('LOAN_NOT_FOUND');

            if (loan.lender.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only lender can perform this');
            // Atomic Intent Consumption inside Financial Transaction
            if (intentId) {
                const TransactionIntent = require('../models/TransactionIntent');
                const intent = await TransactionIntent.findOneAndUpdate(
                    { intentId, status: 'PENDING', expiresAt: { $gt: new Date() } },
                    { status: 'CONSUMED' },
                    { session, new: true }
                );
                if (!intent) {
                    throw new Error('INTENT_INVALID_OR_CONSUMED: Intent was already consumed, expired, or invalid.');
                }
            }

            if (loan.lender.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only lender can perform this');

            // -------------------------------------------------------
            // FINAL INTEREST FLUSH (P1 maturity-close race fix)
            // For interest loans only: accrue any interest not yet
            // captured by the cron worker before computing write-off.
            // This is ATOMIC with the WRITE_OFF in the same session.
            // -------------------------------------------------------
            if (loan.agreementSnapshot && loan.agreementSnapshot.interestMethod === 'SIMPLE_ORIGINAL_PRINCIPAL') {
                const InterestAccrualCalculator = require('./InterestAccrualCalculator');

                // Find the last accrual transaction within this session/snapshot
                const lastAccrualTx = await Transaction.findOne({
                    loanId: loan._id,
                    type: 'INTEREST_ACCRUED'
                }).sort({ accrualEnd: -1 }).session(session);

                const closeDate = new Date();
                const window = InterestAccrualCalculator.determineFinalAccrualWindow(loan, lastAccrualTx, closeDate);

                if (window.needsAccrual) {
                    const { roundedInterestPaise, periodId } = InterestAccrualCalculator.calculate(
                        loan.agreementSnapshot,
                        window.startDate,
                        window.endDate
                    );

                    if (roundedInterestPaise > 0) {
                        // Attempt to create the final INTEREST_ACCRUED in this session.
                        // If the cron already created this period (same periodId), the unique
                        // index on accrualPeriodId will throw E11000. We catch that specifically
                        // and treat it as idempotent — the cron beat us, interest is already recorded.
                        try {
                            await this._commitMutation({
                                loan,
                                type: 'INTEREST_ACCRUED',
                                deltas: { principal: 0, interest: roundedInterestPaise, fees: 0 },
                                amountPaise: roundedInterestPaise,
                                actorId: 'SYSTEM',
                                effectiveAt: window.endDate,
                                accrualPeriodId: periodId,
                                accrualStart: window.startDate,
                                accrualEnd: window.endDate
                            }, session);
                            // loan object is now mutated by _commitMutation (balances updated in-memory)
                        } catch (e) {
                            const isDuplicatePeriod = e.code === 11000 && e.message.includes('accrualPeriodId');
                            if (isDuplicatePeriod) {
                                // Cron won the race — reload the loan to get the cron's committed balances
                                const refreshed = await Loan.findById(loanId).session(session);
                                Object.assign(loan, refreshed.toObject());
                            } else {
                                throw e; // genuine failure — propagate and roll back
                            }
                        }
                    }
                }
            }

            // Re-read authoritative outstanding balances (post-accrual-flush)
            const pAlloc = loan.principalOutstandingPaise;
            const intAlloc = loan.interestOutstandingPaise;
            const feeAlloc = loan.feesOutstandingPaise;
            const totalWriteOff = pAlloc + intAlloc + feeAlloc;

            if (totalWriteOff === 0) throw new Error('NOTHING_TO_WRITE_OFF');

            return await this._commitMutation({
                loan,
                type: 'WRITE_OFF',
                deltas: { principal: pAlloc * -1, interest: intAlloc * -1, fees: feeAlloc * -1 },
                amountPaise: totalWriteOff,
                actorId,
                effectiveAt: new Date(),
                intentId,
                targetState: 'closed' 
            }, session);
        });
    }

    static async reverseTransaction(loanId, targetTxId, actorId, intentId) {
        return this.withTransactionRetry(async (session) => {
            const loan = await Loan.findById(loanId).session(session);
            if (!loan) throw new Error('LOAN_NOT_FOUND');

            if (loan.lender.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only lender can perform this');
            // Atomic Intent Consumption inside Financial Transaction
            if (intentId) {
                const TransactionIntent = require('../models/TransactionIntent');
                const intent = await TransactionIntent.findOneAndUpdate(
                    { intentId, status: 'PENDING', expiresAt: { $gt: new Date() } },
                    { status: 'CONSUMED' },
                    { session, new: true }
                );
                if (!intent) {
                    throw new Error('INTENT_INVALID_OR_CONSUMED: Intent was already consumed, expired, or invalid.');
                }
            }
            
            if (loan.lender.toString() !== actorId) throw new Error('UNAUTHORIZED_ACTION: Only lender can perform this');
            const targetTx = await Transaction.findOne({ transactionId: targetTxId, loanId }).session(session);
            if (!targetTx) throw new Error('TRANSACTION_NOT_FOUND');
            if (targetTx.type !== 'PAYMENT' && targetTx.type !== 'CREDIT_ADDED') throw new Error('NON_REVERSABLE_TYPE');

            const hoursSince = (Date.now() - targetTx.createdAt.getTime()) / (1000 * 60 * 60);
            if (hoursSince > 24) throw new Error('REVERSAL_WINDOW_EXPIRED');

            const dependentTx = await Transaction.findOne({
                loanId,
                effectiveAt: { $gt: targetTx.effectiveAt }
            }).session(session);
            if (dependentTx) throw new Error('REVERSAL_BLOCKED_BY_SUBSEQUENT_MUTATION');

            return await this._commitMutation({
                loan,
                type: 'REVERSAL',
                deltas: {
                    principal: targetTx.principalDeltaPaise * -1,
                    interest: targetTx.interestDeltaPaise * -1,
                    fees: targetTx.feeDeltaPaise * -1
                },
                amountPaise: targetTx.amountPaise,
                actorId,
                effectiveAt: new Date(),
                intentId,
                reversesTransactionId: targetTxId
            }, session);
        });
    }

    static async accrueInterest(loanId, accrualPeriodId, startDate, endDate) {
        return this.withTransactionRetry(async (session) => {
            const loan = await Loan.findById(loanId).session(session);
            if (!loan) throw new Error('LOAN_NOT_FOUND');

            // Cron-triggered: no intent required — SYSTEM actorId
            if (!loan.agreementSnapshot || loan.agreementSnapshot.interestMethod !== 'SIMPLE_ORIGINAL_PRINCIPAL') {
                throw new Error('ACCRUAL_REJECTED: NOT_AN_INTEREST_LOAN');
            }

            // Delegate all math to the shared deterministic calculator
            const InterestAccrualCalculator = require('./InterestAccrualCalculator');
            
            // Cap endDate at maturity (same rule as before, expressed via calculator)
            const effectiveEnd = (loan.endDate && endDate.getTime() > loan.endDate.getTime())
                ? loan.endDate
                : endDate;

            const { roundedInterestPaise } = InterestAccrualCalculator.calculate(
                loan.agreementSnapshot, startDate, effectiveEnd
            );

            if (roundedInterestPaise <= 0) return { success: false, reason: 'ZERO_INTEREST' };

            try {
                const result = await this._commitMutation({
                    loan,
                    type: 'INTEREST_ACCRUED',
                    deltas: { principal: 0, interest: roundedInterestPaise, fees: 0 },
                    amountPaise: roundedInterestPaise,
                    actorId: 'SYSTEM',
                    effectiveAt: effectiveEnd,
                    accrualPeriodId,
                    accrualStart: startDate,
                    accrualEnd: effectiveEnd
                }, session);
                return { success: true, ...result };
            } catch (error) {
                if (error.code === 11000 && error.message.includes('accrualPeriodId')) {
                    return { success: true, idempotent: true };
                }
                throw error;
            }
        });
    }

    // ==========================================
    // LEVEL 1: PRIVATE GENERIC APPEND
    // ==========================================

    static async _commitMutation({ 
        loan, type, deltas, amountPaise, actorId, effectiveAt, 
        intentId = null, reversesTransactionId = null, accrualPeriodId = null, 
        accrualStart = null, accrualEnd = null, targetState = null, notification = null
    }, session) {
        
        const terminalStates = ['completed', 'closed', 'rejected', 'cancelled', 'expired'];
        const currentLowerState = (loan.status || '').toLowerCase();
        
        if (terminalStates.includes(currentLowerState) && type !== 'REVERSAL') {
            throw new Error(`MUTATION_REJECTED: Loan is ${loan.status}`);
        }
        if (type === 'REVERSAL' && terminalStates.includes(currentLowerState)) {
             throw new Error(`MUTATION_REJECTED: Loan is ${loan.status}. Normal reversals are blocked in terminal states.`);
        }
        if (loan.financialStatus === 'FROZEN') {
            throw new Error('MUTATION_REJECTED: Loan is FROZEN');
        }

        const computedAmount = Math.abs(deltas.principal) + Math.abs(deltas.interest) + Math.abs(deltas.fees);
        if ((type === 'PAYMENT' || type === 'WRITE_OFF') && amountPaise !== computedAmount) {
            throw new Error(`INVARIANT_VIOLATION_PAYMENT_MISMATCH: ${amountPaise} != ${computedAmount}`);
        }
        if (type === 'LOAN_CREATED' || type === 'CREDIT_ADDED') {
            if (deltas.principal !== amountPaise || deltas.interest !== 0 || deltas.fees !== 0) throw new Error('SEMANTIC_ERROR_PRINCIPAL_EXPECTED');
        }

        const newPrincipal = loan.principalOutstandingPaise + deltas.principal;
        const newInterest = loan.interestOutstandingPaise + deltas.interest;
        const newFees = loan.feesOutstandingPaise + deltas.fees;

        if (newPrincipal < 0 || newInterest < 0 || newFees < 0) {
            throw new Error('INVARIANT_VIOLATION_NEGATIVE_BALANCE');
        }

        const lastTx = await Transaction.findOne({ loanId: loan._id }).sort({ sequenceNumber: -1 }).session(session);
        const nextSequence = lastTx ? lastTx.sequenceNumber + 1 : 1;

        const businessDate = new Date(effectiveAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const tx = new Transaction({
            loanId: loan._id,
            sequenceNumber: nextSequence,
            type, actorId, effectiveAt, businessDate,
            principalDeltaPaise: deltas.principal,
            interestDeltaPaise: deltas.interest,
            feeDeltaPaise: deltas.fees,
            amountPaise, intentId, reversesTransactionId,
            accrualPeriodId, accrualStart, accrualEnd
        });
        await tx.save({ session });

        loan.principalOutstandingPaise = newPrincipal;
        loan.interestOutstandingPaise = newInterest;
        loan.feesOutstandingPaise = newFees;
        loan.ledgerVersion = 2;
        
        if (targetState) {
            loan.status = targetState;
        } else if (newPrincipal === 0 && newInterest === 0 && newFees === 0) {
            loan.status = 'completed';
        }

        await loan.save({ session });

        if (notification) {
            const User = require('../models/User');
            const NotificationOutbox = require('../models/NotificationOutbox');
            
            const recipientStrId = notification.recipientId; // e.g., 'B1234567890'
            const recipientUser = await User.findOne({ id: recipientStrId }).session(session);
            if (recipientUser) {
                await NotificationOutbox.create([{
                    aggregateType: 'LOAN',
                    aggregateId: loan._id.toString(),
                    eventType: notification.eventType,
                    recipientUserId: recipientUser._id,
                    channel: 'PUSH',
                    payload: {
                        title: notification.title,
                        body: notification.body,
                        ...notification.extraPayload
                    }
                }], { session });
            }
        }

        return { loan, transaction: tx };
    }
}

module.exports = FinancialLedgerService;
