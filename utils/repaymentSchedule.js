const FinancialLedgerService = require('../services/FinancialLedgerService');

exports.generateRepaymentTimeline = (loan) => {
    const startDate = loan.activatedAt || loan.startDate || loan.createdAt;
    if (!startDate || loan.durationMonths == null) {
        return { trackingEnabled: false, reason: 'Missing start date or duration' };
    }

    const durationMonths = loan.durationMonths;
    FinancialLedgerService.deriveBalances(loan);
    
    const originalPrincipal = loan.amountPaise || (loan.amount * 100) || 0;
    const emiAmount = Math.ceil(originalPrincipal / durationMonths);
    
    const timeline = [];
    let periodStart = new Date(startDate);
    
    const payments = (loan.transactions || [])
        .filter(t => t.type === 'payment')
        .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
    
    let remainingToAllocate = loan.paidAmountPaise || 0;
    const totalOutstanding = loan.totalPayablePaise || 0;
    let isCompleted = totalOutstanding <= 0;
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
    if (emiAmount > 0 && totalOutstanding > (loan.paidAmountPaise || 0)) {
        // As long as the periodStart is in the past, a new month box has "arrived"
        while (periodStart < now) {
            const periodEnd = new Date(periodStart);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            const thisMonthDue = emiAmount; // It just continues accumulating
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
            
            // Cap at 12 extra months to avoid infinite loops
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
