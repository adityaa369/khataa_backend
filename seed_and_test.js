
const mongoose = require('mongoose');
const Loan = require('./models/Loan');
const FinancialLedgerService = require('./services/FinancialLedgerService');

mongoose.connect('mongodb://localhost:27017/khatha').then(async () => {
    // 1. Create the loan
    const loan = new Loan({
        _id: new mongoose.Types.ObjectId('6aaa9f354a72eec9ea0f8c62'),
        type: 'hand_credit',
        status: 'active',
        borrower: 'test_borrower',
        borrowerName: 'Aditya',
        borrowerPhone: '1234567890',
        lender: 'test_lender',
        amount: 369369,
        interestRate: 23,
        durationMonths: 15,
        startDate: new Date('2026-09-16T00:00:00.000Z'),
        activatedAt: new Date('2026-09-16T00:00:00.000Z'),
        endDate: new Date('2027-12-16T00:00:00.000Z'),
        transactions: [
            {
                type: 'loan_given',
                amountPaise: 36936900,
                principalAllocationPaise: 36936900,
                recordedAt: new Date('2026-09-16T00:00:00.000Z'),
                effectiveAt: new Date('2026-09-16T00:00:00.000Z')
            }
        ]
    });

    await Loan.deleteMany({ _id: loan._id });
    await loan.save();

    // 2. Mock Request/Response
    const req = { params: { id: loan._id.toString() }, user: { id: 'test_borrower' } };
    const res = {
        status: (code) => res,
        json: (data) => {
            console.log('--- SCHEDULE JSON ---');
            console.log(JSON.stringify(data, null, 2));
            process.exit(0);
        }
    };

    // 3. Call the controller
    const { getInterestSchedule } = require('./controllers/loans');
    await getInterestSchedule(req, res);
});

