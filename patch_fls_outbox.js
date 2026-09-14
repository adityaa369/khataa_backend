const fs = require('fs');

const file = 'services/FinancialLedgerService.js';
let content = fs.readFileSync(file, 'utf8');

const outboxLogic = `
            // Outbox Integration
            let recipientUserId = loan.borrower; 
            let eventType = 'TRANSACTION_COMMITTED';
            let title = 'New Transaction';
            let body = 'A new transaction was recorded. Tap to view.';

            if (type === 'LOAN_CREATED') {
                eventType = 'LOAN_ACCEPTED';
                recipientUserId = loan.lender;
            } else if (type === 'PAYMENT') {
                eventType = 'PAYMENT_COMMITTED';
                recipientUserId = loan.lender;
            } else if (type === 'CREDIT_ADDED') {
                eventType = 'CREDIT_ADDED';
                recipientUserId = loan.borrower;
            } else if (type === 'WRITE_OFF') {
                eventType = 'WRITE_OFF_COMMITTED';
                recipientUserId = loan.borrower;
            } else if (type === 'REVERSAL') {
                eventType = 'REVERSAL_COMMITTED';
                recipientUserId = actorId === loan.lender.toString() ? loan.borrower : loan.lender;
            }

            const NotificationOutbox = require('../models/NotificationOutbox');
            
            // Push Notification Event
            if (recipientUserId && recipientUserId.toString() !== 'SYSTEM') {
                await NotificationOutbox.create([{
                    aggregateType: 'LOAN',
                    aggregateId: loan._id.toString(),
                    eventType,
                    recipientUserId,
                    channel: 'PUSH',
                    payload: { title, body, loanId: loan._id.toString() }
                }], { session });
            }

            await transaction.save({ session });
`;

if (!content.includes('NotificationOutbox.create')) {
    content = content.replace('await transaction.save({ session });', outboxLogic);
    fs.writeFileSync(file, content);
}
console.log('Outbox added to FinancialLedgerService');
