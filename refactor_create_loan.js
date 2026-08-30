const fs = require('fs');

const file = 'controllers/loans.js';
let content = fs.readFileSync(file, 'utf8');

const createLoanReplacement = `
exports.createLoan = async (req, res) => {
    try {
        let { borrower_phone, borrower_name, borrower_aadhar, borrower_address, amount, interest_rate, duration_months, duration_type, type, documentUrl, idempotencyKey } = req.body;
        const borrowerPhone = borrower_phone.toString().replace(/^\\+?91/, '');
        
        if (borrowerPhone === req.user.phone) {
            return res.status(400).json({ success: false, message: 'You cannot give a loan to yourself' });
        }

        // Check borrower
        let borrower = await User.findOne({ phone: borrowerPhone });
        if (!borrower || !borrower.email) {
            return res.status(400).json({ success: false, message: 'Borrower not found or missing email.' });
        }

        // Idempotency constraint using intent or dedicated collection is preferred, but for now we'll ensure we don't create multiple pending offers
        const existingLoan = await Loan.findOne({ 
            lender: req.user.id, borrowerPhone, amount, status: 'pending' 
        });
        if (existingLoan) {
            return res.status(429).json({ success: false, message: 'Duplicate pending offer detected.' });
        }

        const loan = await Loan.create({
            lender: req.user.id,
            borrower: borrower.id,
            borrowerName: borrower_name,
            borrowerPhone,
            borrowerAadhar: borrower_aadhar,
            borrowerAddress: borrower_address,
            amount,
            amountPaise: Math.round(amount * 100),
            interestRate: interest_rate,
            durationMonths: duration_months,
            durationType: duration_type || 'Months',
            loanType: type || 'personal',
            status: 'pending', // strict PENDING offer
            ledgerVersion: 2,
            documentUrl,
            principalOutstandingPaise: 0,
            interestOutstandingPaise: 0,
            feesOutstandingPaise: 0,
            // DO NOT populate transactions array
        });

        res.status(201).json({ success: true, message: 'Loan offer created.', loan });
    } catch (err) {
        console.error('[Loans V2] createLoan Error:', err.message);
        sendError(res, err);
    }
};
`;

content = content.replace(/exports\.createLoan = async \(req, res\) => \{[\s\S]*?\n\};\n/m, createLoanReplacement);

fs.writeFileSync(file, content);
console.log("Refactored createLoan successfully.");
