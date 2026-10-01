const fs = require('fs');
let code = fs.readFileSync('controllers/payments.js', 'utf8');

const startTag = '// 6. OTP valid';
const endTag = '// 11. Return updated loan';

const startIdx = code.indexOf(startTag);
const endIdx = code.indexOf(endTag);

const newBlock = // 6. Overpayment check before transaction
        const amountPaise = intent.payload.amountPaise;
        FinancialLedgerService.deriveBalances(loan);
        const totalOutstandingPaise = (loan.principalOutstandingPaise != null ? loan.principalOutstandingPaise : (loan.totalPayablePaise - (loan.paidAmountPaise || 0))) || 0;

        if (amountPaise > totalOutstandingPaise) {
            await TransactionIntent.updateOne({ intentId }, { status: 'REJECTED' });
            return res.status(400).json({
                success: false,
                code: 'OVERPAYMENT_REJECTED',
                message: \Payment of \\\u20b9\ exceeds outstanding balance of \\\u20b9\\
            });
        }

        // 7. Atomic Execution
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            // Consume challenge
            await OtpChallenge.updateOne({ _id: challenge._id }, { status: 'CONSUMED' }, { session });

            // Execute payment via FROZEN FinancialLedgerService
            // Fixed recordPayment argument signature and logic
            const result = await FinancialLedgerService.recordPayment(loan, amountPaise, intentId, req.user.id);
            
            // Actually save the loan inside the transaction
            await loan.save({ session });

            // Mark intent as committed
            await TransactionIntent.updateOne({ intentId }, { status: 'COMMITTED' }, { session });

            await session.commitTransaction();
        } catch (err) {
            await session.abortTransaction();
            console.error('[CommitPayment] Transaction aborted:', err);
            return res.status(500).json({ success: false, message: 'Payment execution failed', error: err.message });
        } finally {
            session.endSession();
        }

        // 8. Dispatch notifications (outside transaction)
        try {
            await EventDispatcher.dispatch({
                eventType: 'PAYMENT_RECEIVED',
                recipientUserId: intent.userId, // lender
                data: { amountPaise, borrowerId: req.user.id },
                loanId
            });
            await EventDispatcher.dispatch({
                eventType: 'PAYMENT_MADE',
                recipientUserId: req.user.id, // borrower
                data: { amountPaise },
                loanId
            });
        } catch (notifErr) {
            console.error('[CommitPayment] Notification dispatch failed:', notifErr);
        }

        ;

code = code.slice(0, startIdx) + newBlock + code.slice(endIdx);
fs.writeFileSync('controllers/payments.js', code);
console.log('Replaced successfully');
