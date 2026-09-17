
const fs = require('fs');
const code = \
exports.getInterestSchedule = async (req, res) => {
    try {
        const Loan = require('../models/Loan');
        const loan = await Loan.findById(req.params.id);
        
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }
        
        if (loan.lender !== req.user.id && loan.borrower !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this schedule' });
        }

        const FinancialLedgerService = require('../services/FinancialLedgerService');
        FinancialLedgerService.deriveBalances(loan);

        const startDate = loan.activatedAt || loan.startDate || loan.createdAt;
        const durationMonths = loan.durationMonths || 0;
        
        const monthlyBuckets = {};
        
        const getMonthKey = (date) => {
            const d = new Date(date);
            return d.toLocaleString('default', { month: 'short' }) + ' ' + d.getFullYear();
        };

        loan.transactions.forEach(t => {
            const date = t.effectiveAt || t.recordedAt;
            const key = getMonthKey(date);
            if (!monthlyBuckets[key]) {
                monthlyBuckets[key] = {
                    month: key,
                    businessDate: date,
                    accruedPaise: 0,
                    paidPaise: 0,
                    principalPaidPaise: 0
                };
            }
            if (t.type === 'interest_accrued') {
                monthlyBuckets[key].accruedPaise += (t.amountPaise || 0);
            }
            if (t.type === 'payment' || t.type === 'interest_payment') {
                monthlyBuckets[key].paidPaise += (t.interestAllocationPaise || 0);
                monthlyBuckets[key].principalPaidPaise += (t.principalAllocationPaise || 0);
            }
        });

        const historicalSchedule = Object.values(monthlyBuckets).sort((a, b) => new Date(a.businessDate) - new Date(b.businessDate));
        
        let totalAccruedPaise = 0;
        let totalPaidPaise = 0;
        
        historicalSchedule.forEach(p => {
            totalAccruedPaise += p.accruedPaise;
            totalPaidPaise += p.paidPaise;
        });

        let projectedPrincipalPaise = loan.principalOutstandingPaise;
        const ratePct = loan.interestRate || 0;
        const projectedSchedule = [];
        
        if (projectedPrincipalPaise > 0 && ratePct > 0) {
            const endDate = new Date(startDate);
            endDate.setMonth(endDate.getMonth() + durationMonths);
            
            let currentDate = new Date();
            if (loan.status === 'active') {
                while (currentDate < endDate) {
                    currentDate.setMonth(currentDate.getMonth() + 1);
                    const key = getMonthKey(currentDate);
                    if (!monthlyBuckets[key]) {
                        const projectedInterest = Math.floor(projectedPrincipalPaise * ratePct * 12 * 30 / 365 / 100);
                        projectedSchedule.push({
                            month: key,
                            businessDate: new Date(currentDate),
                            dueDate: new Date(currentDate),
                            openingPrincipalPaise: projectedPrincipalPaise,
                            accruedPaise: projectedInterest,
                            interestAccruedPaise: projectedInterest,
                            paidPaise: 0,
                            interestPaidPaise: 0,
                            principalPaidPaise: 0,
                            closingPrincipalPaise: projectedPrincipalPaise,
                            status: 'projected'
                        });
                    }
                }
            }
        }

        const fullSchedule = [...historicalSchedule, ...projectedSchedule].map(p => ({
            ...p,
            interestAccruedPaise: p.accruedPaise,
            interestPaidPaise: p.paidPaise,
            status: p.status || 'historical'
        }));

        res.status(200).json({
            success: true,
            principalOutstandingPaise: loan.principalOutstandingPaise,
            accruedInterestPaise: totalAccruedPaise,
            interestOutstandingPaise: loan.interestOutstandingPaise,
            interestPaidPaise: totalPaidPaise,
            
            totalAccruedPaise: totalAccruedPaise,
            totalPaidPaise: totalPaidPaise,
            outstandingInterestPaise: loan.interestOutstandingPaise,
            originalPrincipalPaise: loan.amountPaise,
            interestRateBps: Math.floor(ratePct * 100),
            interestMethod: 'ACT/365 Exact (Reducing Balance)',
            
            schedule: fullSchedule
        });

    } catch (err) {
        console.error('[Loans] getInterestSchedule Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};
\;
fs.appendFileSync('controllers/loans.js', code);

