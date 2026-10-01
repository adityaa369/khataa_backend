const FinancialLedgerService = require('../services/FinancialLedgerService');

exports.generateRepaymentTimeline = (loan) => {
    const startDate = loan.activatedAt || loan.startDate || loan.createdAt;
    if (!startDate || loan.durationMonths == null) {
        return { trackingEnabled: false, reason: 'Missing start date or duration' };
    }

    const durationMonths = loan.durationMonths;
    const balances = FinancialLedgerService.deriveBalances(loan);
    const emiAmount = Math.ceil((balances.totalPayablePaise || 0) / durationMonths);
    
    const timeline = [];
    let periodStart = new Date(startDate);
    
    // Sort transactions by recorded date
    const payments = (loan.transactions || [])
        .filter(t => t.type === 'payment')
        .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
    
    let remainingToAllocate = balances.totalPaidPaise || 0;
    const totalOutstanding = balances.totalOutstandingPaise || 0;
    
    let isCompleted = totalOutstanding <= 0;
    let monthIndex = 1;

    for (; monthIndex <= durationMonths; monthIndex++) {
        const periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        // Find actual transactions that occurred during this time window
        const periodTxns = payments.filter(t => {
            const tDate = new Date(t.recordedAt);
            return tDate >= periodStart && tDate < periodEnd;
        });

        const totalPeriodTxnsPaise = periodTxns.reduce((sum, t) => sum + (t.amountPaise || 0), 0);

        // Allocate money to this period
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

        // If loan is fully settled and we haven't hit duration end, 
        // the remaining periods could be considered paid (or cancelled).
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
            transactionsPeriodTotalPaise: totalPeriodTxnsPaise, // strictly what was paid IN this time window
            transactions: periodTxns.map(t => ({
                type: t.type,
                amountPaise: t.amountPaise || 0,
                note: t.note || '',
                recordedAt: new Date(t.recordedAt).toISOString()
            }))
        });

        periodStart = new Date(periodEnd);
    }

    // Post term transactions (transactions that happened after the original duration ended)
    const postTermTxns = payments.filter(t => {
        const tDate = new Date(t.recordedAt);
        return tDate >= periodStart;
    });

    // Dynamic Extension: create extra periods if still outstanding
    let remainingOutstandingToProject = totalOutstanding;
    
    // Safety break: don't create infinite periods if outstanding > 0 but EMI is 0 (impossible but safe)
    if (emiAmount > 0 && remainingOutstandingToProject > 0) {
        while (remainingOutstandingToProject > 0) {
            const periodEnd = new Date(periodStart);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            const thisMonthDue = Math.min(remainingOutstandingToProject, emiAmount);
            
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

            if (status === 'unpaid' || status === 'partially_paid') {
                remainingOutstandingToProject -= (thisMonthDue - appliedToPeriod);
            } else {
                remainingOutstandingToProject -= thisMonthDue;
            }

            periodStart = new Date(periodEnd);
            monthIndex++;
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
    const balances = FinancialLedgerService.deriveBalances(loan);
    return {
        totalAccruedPaise: balances.totalInterestAccruedPaise || 0,
        totalPaidPaise: balances.totalInterestPaidPaise || 0,
        outstandingInterestPaise: balances.interestOutstandingPaise || 0,
        originalPrincipalPaise: loan.amountPaise || 0,
        interestRateBps: (loan.interestRate || 0) * 100,
        interestMethod: 'simple',
        schedule: []
    };
};
