const mongoose = require('mongoose');
const { generateRepaymentTimeline } = require('./utils/repaymentSchedule');

const loan = {
    amountPaise: 3000000,
    amount: 30000,
    durationMonths: 4,
    startDate: new Date('2024-01-01T00:00:00Z'),
    transactions: [
        { type: 'loan_given', amountPaise: 3000000, recordedAt: new Date('2024-01-01T00:00:00Z') },
        { type: 'payment', amountPaise: 900000, recordedAt: new Date('2024-01-15T00:00:00Z') },
        { type: 'payment', amountPaise: 1100000, recordedAt: new Date('2024-02-15T00:00:00Z') },
        { type: 'payment', amountPaise: 500000, recordedAt: new Date('2024-03-15T00:00:00Z') },
        { type: 'payment', amountPaise: 500000, recordedAt: new Date('2024-04-15T00:00:00Z') },
    ]
};

console.log("TEST 1: Exact payment");
const t1 = generateRepaymentTimeline(loan);
console.log("Month 1:", t1.timeline[0].status);
console.log("Month 2:", t1.timeline[1].status);
console.log("Month 3:", t1.timeline[2].status);
console.log("Month 4:", t1.timeline[3].status);
console.log("Outstanding:", loan.totalPayablePaise - loan.paidAmountPaise);

const loan2 = {
    amountPaise: 3000000,
    amount: 30000,
    durationMonths: 4,
    startDate: new Date('2024-01-01T00:00:00Z'),
    transactions: [
        { type: 'loan_given', amountPaise: 3000000, recordedAt: new Date('2024-01-01T00:00:00Z') },
        { type: 'payment', amountPaise: 900000, recordedAt: new Date('2024-01-15T00:00:00Z') },
        { type: 'payment', amountPaise: 1100000, recordedAt: new Date('2024-02-15T00:00:00Z') },
        { type: 'payment', amountPaise: 500000, recordedAt: new Date('2024-03-15T00:00:00Z') },
        { type: 'payment', amountPaise: 400000, recordedAt: new Date('2024-04-15T00:00:00Z') },
    ]
};

console.log("\nTEST 2: Partial payment");
const t2 = generateRepaymentTimeline(loan2);
console.log("Month 1:", t2.timeline[0].status);
console.log("Month 2:", t2.timeline[1].status);
console.log("Month 3:", t2.timeline[2].status);
console.log("Month 4:", t2.timeline[3].status);
console.log("Month 5:", t2.timeline[4].status);
console.log("Outstanding:", loan2.totalPayablePaise - loan2.paidAmountPaise);
