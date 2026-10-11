const FinancialLedgerService = require('../services/FinancialLedgerService');

exports.generateRepaymentTimeline = (loan) => {
    const startDate = loan.activatedAt || loan.startDate || loan.createdAt;
    if (!startDate || loan.durationMonths == null) {
        return { trackingEnabled: false, reason: 'Missing start date or duration' };
    }

    let durationMonths = loan.durationMonths;
    if (loan.durationType === 'Days') {
        durationMonths = Math.ceil(durationMonths / 30.0);
        if (durationMonths < 1) durationMonths = 1;
    }
    FinancialLedgerService.deriveBalances(loan);
    // Total obligation to be repaid across this loan
    const totalOutstandingPaise = (loan.principalOutstandingPaise || 0) + (loan.interestOutstandingPaise || 0) + (loan.feesOutstandingPaise || 0);
    const paidAmountPaise = loan.paidAmountPaise || 0;
    let totalOriginalPaise = totalOutstandingPaise + paidAmountPaise;

    if (totalOriginalPaise <= 0) {
        const principalPaise = loan.amountPaise || (loan.amount * 100) || 0;
        const ratePct = loan.interestRate || 0;
        let interestPaise = 0;
        if (ratePct > 0) {
            interestPaise = Math.floor((principalPaise * ratePct * durationMonths) / 100);
        }
        totalOriginalPaise = principalPaise + interestPaise;
    }

    // Each month's expected installment (box value)
    const emiAmount = Math.ceil(totalOriginalPaise / durationMonths);
    let remainingToAllocate = paidAmountPaise;

    const timeline = [];
    let periodStart = new Date(startDate);

    const payments = (loan.transactions || [])
        .filter(t => t.type === 'payment' || t.type === 'interest_payment')
        .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));

    const isCompleted = totalOutstandingPaise <= 0 && paidAmountPaise > 0;
    let monthIndex = 1;

    for (; monthIndex <= durationMonths; monthIndex++) {
        const periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

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
        }

        timeline.push({
            periodIndex: monthIndex,
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

    // Dynamic Extension: create extra periods ONLY if chronologically exceeded AND unpaid
    const now = new Date();
    if (emiAmount > 0 && totalOutstandingPaise > 0) {
        while (periodStart < now) {
            const periodEnd = new Date(periodStart);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            const thisMonthDue = emiAmount;
            let appliedToPeriod = 0;
            let status = 'unpaid';

            if (remainingToAllocate >= thisMonthDue) {
                status = 'paid';
                appliedToPeriod = thisMonthDue;
                remainingToAllocate -= thisMonthDue;
            } else if (remainingToAllocate > 0) {
                status = 'partially_paid';
                appliedToPeriod = remainingToAllocate;
                remainingToAllocate = 0;
            }

            const periodTxns = payments.filter(t => {
                const tDate = new Date(t.recordedAt);
                return tDate >= periodStart && tDate < periodEnd;
            });

            timeline.push({
                periodIndex: monthIndex,
                periodStart: periodStart.toISOString(),
                periodEnd: periodEnd.toISOString(),
                status,
                expectedAmountPaise: thisMonthDue,
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
            monthIndex++;

            if (monthIndex > durationMonths + 12) break;
        }
    }

    return {
        trackingEnabled: true,
        data: {
            durationMonths: durationMonths,
            startDate: startDate.toISOString(),
            anchorSource: 'activatedAt',
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
