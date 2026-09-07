require('dotenv').config();
const mongoose = require('mongoose');
const { execSync } = require('child_process');
const ReconciliationEngine = require('./workers/ReconciliationEngine');

// Ensure key is set
process.env.BACKUP_ENCRYPTION_KEY = 'test_backup_encryption_key_32_bytes_long_minimum!';

async function testDR() {
    console.log('\n--- 1. SEEDING PRODUCTION DB ---');
    await mongoose.connect('mongodb://localhost:27017/khatha');
    
    const Loan = require('./models/Loan');
    const Transaction = require('./models/Transaction');
    const TransactionIntent = require('./models/TransactionIntent');
    const NotificationOutbox = require('./models/NotificationOutbox');
    const AlertRecord = require('./models/AlertRecord');

    await Loan.deleteMany({});
    await mongoose.connection.db.collection('transactions').deleteMany({});
    await TransactionIntent.deleteMany({});
    await NotificationOutbox.deleteMany({});
    await AlertRecord.deleteMany({});

    const loanId = new mongoose.Types.ObjectId();
    const intentId = new mongoose.Types.ObjectId();

    await mongoose.connection.db.collection('loans').insertOne({
        _id: loanId,
        borrower: new mongoose.Types.ObjectId(),
        lender: new mongoose.Types.ObjectId(),
        amountPaise: 100000,
        principalOutstandingPaise: 100000,
        interestOutstandingPaise: 5000,
        feesOutstandingPaise: 0,
        status: 'active',
        financialStatus: 'NORMAL',
        ledgerVersion: 2,
        createdAt: new Date()
    });

    await mongoose.connection.db.collection('transactions').insertOne({
        loanId: loanId,
        type: 'LOAN_DISBURSEMENT',
        principalDeltaPaise: 100000,
        interestDeltaPaise: 5000,
        feeDeltaPaise: 0,
        timestamp: new Date()
    });

    await mongoose.connection.db.collection('transactionintents').insertOne({
        _id: intentId,
        loanId: loanId,
        amountPaise: 100000,
        status: 'PENDING'
    });

    await mongoose.connection.db.collection('notificationoutboxes').insertOne({
        userId: new mongoose.Types.ObjectId(),
        type: 'PAYMENT_REMINDER',
        status: 'PENDING'
    });

    await mongoose.connection.db.collection('alertrecords').insertOne({
        type: 'TEST_ALERT',
        severity: 'INFO',
        message: 'This is a test alert'
    });

    console.log('Inserted documents into production DB.');
    await mongoose.disconnect();

    console.log('\n--- 2. RUNNING BACKUP ---');
    process.env.MONGODB_URI = 'mongodb://localhost:27017/khatha';
    const backupScript = require('./scripts/backup');
    const backupFile = await backupScript();

    console.log('\n--- 3. RUNNING RESTORE TO ISOLATED DB ---');
    const restoreScript = require('./scripts/restore');
    await restoreScript(backupFile, 'mongodb://localhost:27017/khatha_restore_test');

    console.log('\n--- 4. VERIFYING RESTORED DB ---');
    await mongoose.connect('mongodb://localhost:27017/khatha_restore_test');

    const loanCount = await Loan.countDocuments();
    const txCount = await Transaction.countDocuments();
    const intentCount = await TransactionIntent.countDocuments();
    const outboxCount = await NotificationOutbox.countDocuments();
    const alertCount = await AlertRecord.countDocuments();

    console.log(`Loan Count: ${loanCount}`);
    console.log(`Transaction Count: ${txCount}`);
    console.log(`TransactionIntent Count: ${intentCount}`);
    console.log(`NotificationOutbox Count: ${outboxCount}`);
    console.log(`AlertRecord Count: ${alertCount}`);

    if (loanCount !== 1 || txCount !== 1 || intentCount !== 1 || outboxCount !== 1 || alertCount !== 1) {
        throw new Error('Count mismatch!');
    }

    const restoredLoan = await Loan.findOne();
    if (!(restoredLoan._id instanceof mongoose.Types.ObjectId)) {
        throw new Error('ObjectId type not preserved!');
    }
    if (!(restoredLoan.createdAt instanceof Date)) {
        throw new Error('Date type not preserved!');
    }
    console.log('✅ BSON Types preserved successfully (ObjectId, Date)');

    console.log('\n--- 5. RUNNING V2 RECONCILIATION ON RESTORED DB ---');
    const reconResults = await ReconciliationEngine.runReconciliation();
    console.log('Reconciliation Results:', reconResults);
    
    const alerts = await AlertRecord.find({ type: { $regex: /MISMATCH/ } });
    if (alerts.length > 0) {
        throw new Error('Reconciliation found mismatches in restored DB!');
    }
    console.log('✅ V2 Reconciliation passed on restored DB with 0 alerts');

    await mongoose.disconnect();
    console.log('\n✅ ALL DR VERIFICATIONS PASSED');
}

testDR().catch(err => {
    console.error(err);
    process.exit(1);
});
