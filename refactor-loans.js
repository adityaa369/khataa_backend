const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'controllers', 'loans.js');
let code = fs.readFileSync(filePath, 'utf8');

// 1. Inject dbTransaction requirement
if (!code.includes('dbTransaction')) {
    code = code.replace(
        "const { invalidateLoanCache } = require('../middleware/cache');",
        "const { invalidateLoanCache } = require('../middleware/cache');\nconst { withTransaction } = require('../utils/dbTransaction');"
    );
}

// 2. Refactor getGivenLoans to use DB sorting
code = code.replace(
    /let loansWithLender = await Loan\.find\(\{ lender: req\.user\.id \}\);[\s\S]*?loansWithLender\.sort\(\(a, b\) => \{[\s\S]*?\}\);/,
    "let loansWithLender = await Loan.find({ lender: req.user.id }).sort({ createdAt: -1 });"
);

// 3. Refactor getTakenLoans to use DB sorting
code = code.replace(
    /let loansWithBorrower = await Loan\.find\(\{ borrower: req\.user\.id \}\);[\s\S]*?loansWithBorrower\.sort\(\(a, b\) => \{[\s\S]*?\}\);/,
    "let loansWithBorrower = await Loan.find({ borrower: req.user.id }).sort({ createdAt: -1 });"
);

// 4. Refactor _handleCustomTransaction (The Overpayment + Transaction Fix + Paise)
const handleTxRegex = /async function _handleCustomTransaction\(req, res, actionType\) \{[\s\S]*?exports\.recordPayment =/m;
const newHandleTx = `async function _handleCustomTransaction(req, res, actionType) {
    try {
        const { amount } = req.body;
        const amountPaise = Math.round(amount * 100);

        const { loan, notifTitle, notifBody } = await withTransaction(async (session) => {
            const currentLoan = await Loan.findById(req.params.id).session(session);
            if (!currentLoan) throw new Error('LOAN_NOT_FOUND');
            if (currentLoan.lender !== req.user.id) throw new Error('UNAUTHORIZED');
            
            let title = 'Transaction Complete';
            let body = '';

            if (actionType === 'recordPayment' || actionType === 'recordInterest') {
                if (amount > currentLoan.totalPayable || amountPaise > currentLoan.totalPayablePaise) {
                    throw new Error('OVERPAYMENT_PROHIBITED');
                }
                
                // Float Fields
                currentLoan.totalPayable = Math.max(0, currentLoan.totalPayable - amount);
                currentLoan.paidAmount = (currentLoan.paidAmount || 0) + amount;
                
                // Paise Fields
                currentLoan.totalPayablePaise = Math.max(0, (currentLoan.totalPayablePaise || 0) - amountPaise);
                currentLoan.paidAmountPaise = (currentLoan.paidAmountPaise || 0) + amountPaise;

                title = 'Payment Recorded';
                body = \`Your lender recorded a payment of ?\${amount}. Your remaining balance is ?\${currentLoan.totalPayable}.\`;
                
                if (!currentLoan.transactions) currentLoan.transactions = [];
                currentLoan.transactions.push({
                    type: actionType === 'recordInterest' ? 'interest_payment' : 'payment',
                    amount,
                    amountPaise,
                    note: actionType === 'recordInterest' ? 'Interest payment' : 'Principal payment',
                    recordedAt: new Date(),
                    recordedBy: req.user.id
                });
            } else if (actionType === 'addCredit') {
                currentLoan.totalPayable += amount;
                currentLoan.totalPayablePaise = (currentLoan.totalPayablePaise || 0) + amountPaise;
                
                title = 'Credit Added';
                body = \`Your lender added a credit of ?\${amount}. Your total payable is now ?\${currentLoan.totalPayable}.\`;
                
                if (!currentLoan.transactions) currentLoan.transactions = [];
                currentLoan.transactions.push({
                    type: 'credit_added',
                    amount,
                    amountPaise,
                    note: 'Credit added by lender',
                    recordedAt: new Date(),
                    recordedBy: req.user.id
                });
            }

            if (currentLoan.totalPayablePaise <= 0) {
                currentLoan.status = 'completed';
                currentLoan.progress = 1.0;
            }

            await currentLoan.save({ session });
            return { loan: currentLoan, notifTitle: title, notifBody: body };
        });

        // External Side Effects (Emails, Notifications)
        await invalidateLoanCache(loan.lender, loan.borrower);
        
        if (loan.borrower) {
            await updateCreditScore(loan.borrower);
            const borrowerUser = await User.findOne({ id: loan.borrower });
            if (borrowerUser && borrowerUser.fcmToken) {
                sendPushNotification(
                    borrowerUser.fcmToken,
                    notifTitle,
                    notifBody,
                    { type: 'LOAN_TRANSACTION', loanId: loan._id.toString() }
                ).catch(e => {});
            }
        }
        res.status(200).json({ success: true, loan, transactions: loan.transactions || [] });
    } catch (err) {
        if (err.message === 'OVERPAYMENT_PROHIBITED') return res.status(400).json({ success: false, message: 'Cannot pay more than outstanding balance' });
        sendError(res, err);
    }
}

exports.recordPayment =`;
code = code.replace(handleTxRegex, newHandleTx);

// 5. Refactor createLoan
const createLoanRegex = /exports\.createLoan = async \(req, res\) => \{[\s\S]*?res\.status\(201\)\.json\(\{ success: true, loan \}\);[\s\S]*?\} catch \(err\) \{/m;
const newCreateLoan = `exports.createLoan = async (req, res) => {
    try {
        const { borrowerPhone, borrowerName, amount, interestRate, durationMonths, durationType, loanType } = req.body;
        
        const amountPaise = Math.round(amount * 100);
        
        let totalPayable = amount;
        let totalPayablePaise = amountPaise;
        
        if (loanType === 'interest_credit') {
            const monthlyInterest = amount * (interestRate || 0) / 100;
            totalPayable = amount + (monthlyInterest * durationMonths);
            totalPayablePaise = Math.round(totalPayable * 100);
        } else if (interestRate > 0) {
            const P = amount;
            const r = interestRate / 100 / 12;
            const n = durationType === 'Days' ? (durationMonths / 30) : durationMonths;
            const emi = P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
            totalPayable = emi * (durationType === 'Days' ? 1 : n);
            totalPayablePaise = Math.round(totalPayable * 100);
        }

        const loan = await withTransaction(async (session) => {
            let borrower = await User.findOne({ phone: borrowerPhone }).session(session);
            
            const newLoan = new Loan({
                lender: req.user.id,
                borrowerPhone,
                borrowerName,
                borrower: borrower ? borrower.id : null,
                amount,
                amountPaise,
                interestRate,
                durationMonths,
                durationType,
                loanType,
                totalPayable,
                totalPayablePaise,
                status: 'pending_approval'
            });

            await newLoan.save({ session });
            return newLoan;
        });

        res.status(201).json({ success: true, loan });
    } catch (err) {`;
code = code.replace(createLoanRegex, newCreateLoan);

// 6. Refactor verifyLoan (State Machine Guard & Transaction)
const verifyLoanRegex = /exports\.verifyLoan = async \(req, res\) => \{[\s\S]*?res\.status\(200\)\.json\(\{ success: true, loan \}\);[\s\S]*?\} catch \(err\) \{/m;
const newVerifyLoan = `exports.verifyLoan = async (req, res) => {
    try {
        const { otp } = req.body; // Deprecated OTP validation fallback
        const loanId = req.params.id;

        const { loan, notifyParams } = await withTransaction(async (session) => {
            const loanRecord = await Loan.findById(loanId).session(session);
            if (!loanRecord) throw new Error('LOAN_NOT_FOUND');
            if (loanRecord.borrowerPhone !== req.user.phone) throw new Error('UNAUTHORIZED');
            
            // STRICT STATE MACHINE GUARD
            if (loanRecord.status !== 'pending_approval') {
                throw new Error('INVALID_STATE_TRANSITION');
            }

            loanRecord.status = 'active';
            loanRecord.activatedAt = new Date();
            loanRecord.borrower = req.user.id;
            
            if (!loanRecord.transactions) loanRecord.transactions = [];
            loanRecord.transactions.push({
                type: 'loan_given',
                amount: loanRecord.amount,
                amountPaise: loanRecord.amountPaise,
                note: 'Loan activated and accepted by borrower',
                recordedAt: new Date(),
                recordedBy: req.user.id
            });

            await loanRecord.save({ session });
            
            return {
                loan: loanRecord,
                notifyParams: { lenderId: loanRecord.lender, borrowerName: loanRecord.borrowerName }
            };
        });

        // External side-effects
        await invalidateLoanCache(notifyParams.lenderId, loan.borrower);
        
        res.status(200).json({ success: true, loan });
    } catch (err) {
        if (err.message === 'INVALID_STATE_TRANSITION') return res.status(400).json({ success: false, message: 'Loan cannot be activated from its current state.'});
        if (err.message === 'UNAUTHORIZED') return res.status(403).json({ success: false, message: 'You are not authorized to verify this loan.'});
        if (err.message === 'LOAN_NOT_FOUND') return res.status(404).json({ success: false, message: 'Loan not found.'});
`;
code = code.replace(verifyLoanRegex, newVerifyLoan);

fs.writeFileSync(filePath, code);
console.log('controllers/loans.js successfully refactored.');
