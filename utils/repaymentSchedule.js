const FinancialLedgerService = require('../services/FinancialLedgerService');

const DAY_MS = 24 * 60 * 60 * 1000;

exports.generateRepaymentTimeline = (loan) => {
    const startRaw = loan.startDate || loan.activatedAt || loan.createdAt;
    if (!startRaw || loan.durationMonths == null) {
        return { trackingEnabled: false, reason: 'Missing start date or duration' };
    }

    const startDate = new Date(startRaw);
    const now = new Date();

    FinancialLedgerService.deriveBalances(loan);

    const totalOutstandingPaise =
        (loan.principalOutstandingPaise || 0) +
        (loan.interestOutstandingPaise || 0) +
        (loan.feesOutstandingPaise || 0);
    const paidAmountPaise = loan.paidAmountPaise || 0;
    let totalOriginalPaise = totalOutstandingPaise + paidAmountPaise;

    // Determine whether this loan is tracked in Days or Months
    const isDaysType = String(loan.durationType || '').toLowerCase() === 'days';
    let totalDays = 0;
    let numInitialPeriods = 1;

    if (isDaysType) {
        totalDays = Math.max(1, Number(loan.durationMonths) || 1);
        // If endDate is explicitly further out than durationMonths days, honor the larger span
        if (loan.endDate) {
            const diffFromEnd = Math.round((new Date(loan.endDate) - startDate) / DAY_MS);
            if (diffFromEnd > totalDays) {
                totalDays = diffFromEnd;
            }
        }
        // Slice into 30-day boxes: e.g. 24 days -> 1 box (24d); 45 days -> 2 boxes (30d + 15d); 56 days -> 2 boxes (30d + 26d)
        // Absorb 1-2 extra days from 31-day calendar months (e.g. 31d -> 1 box, 61/62d -> 2 boxes) so no 1-day stub box is created
        if (totalDays >= 30 && (totalDays % 30 === 1 || totalDays % 30 === 2)) {
            numInitialPeriods = Math.max(1, Math.round(totalDays / 30.0));
        } else {
            numInitialPeriods = Math.max(1, Math.ceil(totalDays / 30.0));
        }
    } else {
        // Months mode — but check if endDate indicates a day-based duration (e.g., 45 days saved as 1 month)
        if (loan.endDate && Number(loan.durationMonths) === 1) {
            const diffDays = Math.round((new Date(loan.endDate) - startDate) / DAY_MS);
            if (diffDays > 32) {
                totalDays = diffDays;
                numInitialPeriods = Math.ceil(totalDays / 30.0);
            }
        }
        if (totalDays === 0) {
            numInitialPeriods = Math.max(1, Number(loan.durationMonths) || 1);
        }
    }

    if (totalOriginalPaise <= 0) {
        const principalPaise = loan.amountPaise || (loan.amount * 100) || 0;
        const ratePct = loan.interestRate || 0;
        let interestPaise = 0;
        if (ratePct > 0) {
            const effectiveMonths = totalDays > 0 ? (totalDays / 30.0) : numInitialPeriods;
            interestPaise = Math.floor((principalPaise * ratePct * effectiveMonths) / 100);
        }
        totalOriginalPaise = principalPaise + interestPaise;
    }

    const emiAmount = Math.ceil(totalOriginalPaise / numInitialPeriods);
    let remainingToAllocate = paidAmountPaise;

    const timeline = [];
    let periodStart = new Date(startDate);

    const payments = (loan.transactions || [])
        .filter(t => t.type === 'payment' || t.type === 'interest_payment')
        .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));

    const isCompleted =
        loan.status === 'completed' ||
        loan.status === 'closed' ||
        (totalOutstandingPaise <= 0 && paidAmountPaise > 0);

    let periodIndex = 1;
    let remainingDaysToSchedule = totalDays;

    // 1. Generate Initial Agreed Period Boxes
    for (; periodIndex <= numInitialPeriods; periodIndex++) {
        const periodEnd = new Date(periodStart);

        if (totalDays > 0) {
            // Day-based slicing: up to 30 days per box, and exact remaining days on the final box
            const sliceDays = periodIndex < numInitialPeriods
                ? Math.min(30, remainingDaysToSchedule)
                : Math.max(1, remainingDaysToSchedule);
            periodEnd.setTime(periodStart.getTime() + sliceDays * DAY_MS);
            remainingDaysToSchedule -= sliceDays;
        } else {
            periodEnd.setMonth(periodEnd.getMonth() + 1);
        }

        const periodTxns = payments.filter(t => {
            const tDate = new Date(t.recordedAt);
            return tDate >= periodStart && tDate < periodEnd;
        });

        const totalPeriodTxnsPaise = periodTxns.reduce((sum, t) => sum + (t.amountPaise || 0), 0);
        let appliedToPeriod = 0;
        let status = 'unpaid';

        if (remainingToAllocate >= emiAmount) {
            status = 'paid';
            appliedToPeriod = emiAmount;
            remainingToAllocate -= emiAmount;
        } else if (remainingToAllocate > 0) {
            status = 'partially_paid';
            appliedToPeriod = remainingToAllocate;
            remainingToAllocate = 0;
        }

        if (isCompleted && status !== 'paid') {
            status = 'paid';
        } else if (status === 'unpaid' && now >= periodEnd) {
            // Period has ended without payment -> mark OVERDUE so red cross (✗) appears
            status = 'overdue';
        }

        timeline.push({
            periodIndex,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            status,
            expectedAmountPaise: emiAmount,
            appliedAmountPaise: appliedToPeriod,
            hasPayments: periodTxns.length > 0,
            transactionsPeriodTotalPaise: totalPeriodTxnsPaise,
            transactions: periodTxns.map(t => ({
                type: t.type,
                amountPaise: t.amountPaise || 0,
                note: t.note || '',
                recordedAt: new Date(t.recordedAt).toISOString()
            }))
        });

        periodStart = new Date(periodEnd);
    }

    const postTermTxns = payments.filter(t => {
        const tDate = new Date(t.recordedAt);
        return tDate >= periodStart;
    });

    // 2. Dynamic Overdue Extension:
    // Whenever the previous box has expired (periodStart <= now) AND the credit still has unpaid balance,
    // automatically append the next period box so the previous box shows a Red Cross (✗) and a new box appears next to it!
    const extensionStepDays = totalDays > 0 && totalDays < 30 ? totalDays : 30;

    if (!isCompleted && emiAmount > 0 && totalOutstandingPaise > 0) {
        while (periodStart <= now) {
            const periodEnd = new Date(periodStart);
            if (totalDays > 0) {
                periodEnd.setTime(periodStart.getTime() + extensionStepDays * DAY_MS);
            } else {
                periodEnd.setMonth(periodEnd.getMonth() + 1);
            }

            const thisPeriodDue = Math.min(emiAmount, totalOutstandingPaise);
            let appliedToPeriod = 0;
            let status = 'unpaid';

            if (remainingToAllocate >= thisPeriodDue) {
                status = 'paid';
                appliedToPeriod = thisPeriodDue;
                remainingToAllocate -= thisPeriodDue;
            } else if (remainingToAllocate > 0) {
                status = 'partially_paid';
                appliedToPeriod = remainingToAllocate;
                remainingToAllocate = 0;
            }

            if (status === 'unpaid' && now >= periodEnd) {
                status = 'overdue';
            }

            const periodTxns = payments.filter(t => {
                const tDate = new Date(t.recordedAt);
                return tDate >= periodStart && tDate < periodEnd;
            });

            timeline.push({
                periodIndex,
                periodStart: periodStart.toISOString(),
                periodEnd: periodEnd.toISOString(),
                status,
                expectedAmountPaise: thisPeriodDue,
                appliedAmountPaise: appliedToPeriod,
                hasPayments: periodTxns.length > 0,
                transactionsPeriodTotalPaise: periodTxns.reduce((sum, t) => sum + (t.amountPaise || 0), 0),
                transactions: periodTxns.map(t => ({
                    type: t.type,
                    amountPaise: t.amountPaise || 0,
                    note: t.note || '',
                    recordedAt: new Date(t.recordedAt).toISOString()
                }))
            });

            periodStart = new Date(periodEnd);
            periodIndex++;

            if (periodIndex > numInitialPeriods + 24) break;
        }
    }

    return {
        trackingEnabled: true,
        data: {
            durationMonths: numInitialPeriods,
            totalDays: totalDays > 0 ? totalDays : null,
            durationType: isDaysType ? 'Days' : 'Months',
            startDate: startDate.toISOString(),
            anchorSource: 'startDate',
            timeline,
            postTermTransactions: postTermTxns.map(t => ({
                type: t.type,
                amountPaise: t.amountPaise || 0,
                note: t.note || '',
                recordedAt: new Date(t.recordedAt).toISOString()
            }))
        }
    };
};

exports.generateInterestSchedule = (loan) => {
    FinancialLedgerService.deriveBalances(loan);
    return {
        totalAccruedPaise: loan.interestOutstandingPaise || 0,
        totalPaidPaise: loan.paidAmountPaise || 0,
        outstandingInterestPaise: loan.interestOutstandingPaise || 0,
        originalPrincipalPaise: loan.amountPaise || (loan.amount * 100) || 0,
        interestRateBps: (loan.interestRate || 0) * 100,
        interestMethod: 'simple',
        schedule: []
    };
};
