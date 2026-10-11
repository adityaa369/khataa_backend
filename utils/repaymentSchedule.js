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
    
    const loanTypeStr = (loan.loanType || loan.type || '').toLowerCase();
    const isInterestCredit = loanTypeStr.includes('interest') || loanTypeStr.includes('home');

    let emiAmount = 0;
    let remainingToAllocate = 0;

    if (isInterestCredit) {
        // For Interest Credit, the timeline represents the Monthly Interest Overview
        // Calculate total interest paid
        const interestPaidPaise = (loan.transactions || [])
            .filter(t => t.type === 'payment' || t.type === 'interest_payment')
            .reduce((sum, t) => {
                if (t.interestAllocationPaise != null) {
                    return sum + t.interestAllocationPaise;
                }
                if (t.note && t.note.toLowerCase().includes('interest')) {
                    return sum + (t.amountPaise || 0);
                }
                return sum;
            }, 0);

        const interestTxns = (loan.transactions || []).filter(t => t.type === 'interest_accrued');
        let totalInterestPaise = 0;
        if (interestTxns.length > 0) {
            totalInterestPaise = interestTxns.reduce((sum, t) => sum + (t.interestAllocationPaise || t.amountPaise || 0), 0);
        } else {
            const ratePct = loan.interestRate || 0;
            const principalPaise = loan.amountPaise || (loan.amount * 100) || 0;
            if (ratePct > 0) {
                totalInterestPaise = Math.floor((principalPaise * ratePct * durationMonths) / 100);
            } else if (loan.interestOutstandingPaise != null) {
                totalInterestPaise = loan.interestOutstandingPaise + interestPaidPaise;
            }
        }

        // Each month expects 1 month's interest
        emiAmount = Math.ceil(totalInterestPaise / durationMonths);

        remainingToAllocate = interestPaidPaise;
    } else {
        const originalPrincipal = loan.amountPaise || (loan.amount * 100) || 0;
        emiAmount = Math.ceil(originalPrincipal / durationMonths);
        remainingToAllocate = loan.paidAmountPaise || 0;
    }

    const timeline = [];
    let periodStart = new Date(startDate);

    const payments = (loan.transactions || [])
        .filter(t => t.type === 'payment' || t.type === 'interest_payment')
        .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));

    const totalOutstanding = loan.totalPayablePaise || 0;
    let isCompleted = totalOutstanding <= 0;
    let isInterestFullyPaid = isInterestCredit && (loan.interestOutstandingPaise <= 0);
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

        if ((isCompleted || isInterestFullyPaid) && status !== 'paid') {
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
    const remainingUnpaid = isInterestCredit ? (loan.interestOutstandingPaise || 0) : totalOutstanding;
    if (emiAmount > 0 && remainingUnpaid > 0) {
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
