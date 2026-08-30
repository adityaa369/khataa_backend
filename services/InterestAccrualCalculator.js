/**
 * InterestAccrualCalculator
 *
 * A pure, stateless, deterministic calculator for simple interest accrual.
 * This is the SINGLE authoritative calculation path used by both:
 *   - InterestAccrualWorker (daily cron)
 *   - FinancialLedgerService.writeOffAndClose (final flush before closing)
 *
 * It never writes to the database. It only produces a calculation result.
 * The FinancialLedgerService is the only component that writes INTEREST_ACCRUED.
 */
class InterestAccrualCalculator {

    /**
     * Calculates simple interest for a period using ACT/365 with the
     * original-principal basis from the agreementSnapshot.
     *
     * @param {object} agreementSnapshot - Immutable loan agreement
     * @param {Date} startDate - Inclusive start of accrual period
     * @param {Date} endDate - Exclusive end of accrual period
     * @returns {{ roundedInterestPaise: number, elapsedDays: number, periodId: string }}
     */
    static calculate(agreementSnapshot, startDate, endDate) {
        if (!agreementSnapshot || agreementSnapshot.interestMethod !== 'SIMPLE_ORIGINAL_PRINCIPAL') {
            throw new Error('ACCRUAL_CALC_REJECTED: Not a simple-interest loan');
        }
        if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
            throw new Error('ACCRUAL_CALC_ERROR: Invalid date types');
        }

        const elapsedMs = endDate.getTime() - startDate.getTime();
        const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

        if (elapsedDays <= 0) {
            return { roundedInterestPaise: 0, elapsedDays: 0, periodId: null };
        }

        const rateDecimal = agreementSnapshot.interestRateBps / 10000;
        const rawInterest = agreementSnapshot.expectedPrincipalPaise * rateDecimal * (elapsedDays / 365);
        const roundedInterestPaise = Math.round(rawInterest);

        // Canonical period ID — same format as InterestAccrualWorker.
        // This is the idempotency key for the unique index on Transaction.accrualPeriodId.
        const sStr = startDate.toISOString().split('T')[0];
        const eStr = endDate.toISOString().split('T')[0];
        const periodId = `ACCRUAL_${sStr}_${eStr}`;

        return { roundedInterestPaise, elapsedDays, periodId };
    }

    /**
     * Determines the final accrual window for a loan being closed.
     *
     * Rules (Revision 6):
     *  - Interest accrues from the end of the last accrued period.
     *  - Interest stops at maturityDate OR closeDate, whichever is EARLIER.
     *  - The [start, end) convention: endDate is exclusive.
     *
     * @param {object} loan - The loan document (with agreementSnapshot, endDate)
     * @param {object|null} lastAccrualTx - The most recent INTEREST_ACCRUED transaction or null
     * @param {Date} closeDate - The moment the close operation is executing (IST normalised to day boundary)
     * @returns {{ needsAccrual: boolean, startDate: Date, endDate: Date, periodId: string } | { needsAccrual: false }}
     */
    static determineFinalAccrualWindow(loan, lastAccrualTx, closeDate) {
        const accrualStartDate = lastAccrualTx ? lastAccrualTx.accrualEnd : loan.createdAt;

        // Interest stops at the earlier of: maturityDate or closeDate
        let accrualEndDate = closeDate;
        if (loan.endDate && loan.endDate < closeDate) {
            accrualEndDate = loan.endDate;
        }

        // Normalise both to IST day boundaries (strip intraday time to avoid partial-day duplicates)
        const normalise = (d) => {
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
            });
            const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
            return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+05:30`);
        };

        const normStart = normalise(accrualStartDate);
        const normEnd   = normalise(accrualEndDate);

        if (normEnd.getTime() <= normStart.getTime()) {
            return { needsAccrual: false };
        }

        const sStr = normStart.toISOString().split('T')[0];
        const eStr = normEnd.toISOString().split('T')[0];
        const periodId = `ACCRUAL_${sStr}_${eStr}`;

        return { needsAccrual: true, startDate: normStart, endDate: normEnd, periodId };
    }
}

module.exports = InterestAccrualCalculator;
