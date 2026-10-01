const assert = require('assert');
const { generateRepaymentTimeline } = require('./utils/repaymentSchedule');

console.log('--- TEST: REPAYMENT SCHEDULE CASE A (9k, 11k, 5k, 5k) ---');
let loanA = {
    amountPaise: 3000000,
    durationMonths: 4,
    activatedAt: new Date('2026-08-01T00:00:00.000Z'),
    transactions: [
        { type: 'payment', amountPaise: 900000, recordedAt: '2026-08-15T00:00:00.000Z' },
        { type: 'payment', amountPaise: 1100000, recordedAt: '2026-09-15T00:00:00.000Z' },
        { type: 'payment', amountPaise: 500000, recordedAt: '2026-10-15T00:00:00.000Z' },
        { type: 'payment', amountPaise: 500000, recordedAt: '2026-11-15T00:00:00.000Z' },
    ]
};

const FinancialLedgerService = require('./services/FinancialLedgerService');
FinancialLedgerService.deriveBalances = (loan) => {
    let totalPaid = loan.transactions.reduce((s,t) => s + t.amountPaise, 0);
    return {
        totalPayablePaise: 3000000,
        totalPaidPaise: totalPaid,
        totalOutstandingPaise: 3000000 - totalPaid,
    };
};

let resA = generateRepaymentTimeline(loanA);
console.log(resA.data.timeline.map(p => ({
    Month: p.periodIndex,
    Status: p.status,
    Applied: p.appliedAmountPaise,
    RemainingOutstanding: 3000000 - loanA.transactions.reduce((s,t) => s + t.amountPaise, 0)
})));

console.log('--- TEST: REPAYMENT SCHEDULE CASE B (9k, 11k, 5k, 4k) ---');
let loanB = {
    amountPaise: 3000000,
    durationMonths: 4,
    activatedAt: new Date('2026-08-01T00:00:00.000Z'),
    transactions: [
        { type: 'payment', amountPaise: 900000, recordedAt: '2026-08-15T00:00:00.000Z' },
        { type: 'payment', amountPaise: 1100000, recordedAt: '2026-09-15T00:00:00.000Z' },
        { type: 'payment', amountPaise: 500000, recordedAt: '2026-10-15T00:00:00.000Z' },
        { type: 'payment', amountPaise: 400000, recordedAt: '2026-11-15T00:00:00.000Z' },
    ]
};
let resB = generateRepaymentTimeline(loanB);
console.log(resB.data.timeline.map(p => ({
    Month: p.periodIndex,
    Status: p.status,
    Applied: p.appliedAmountPaise,
    Outstanding: 3000000 - loanB.transactions.reduce((s,t) => s + t.amountPaise, 0)
})));

