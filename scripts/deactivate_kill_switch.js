
require('dotenv').config();
const mongoose = require('mongoose');

async function deactivate() {
    try {
        console.log('Connecting to database...');
        await mongoose.connect(process.env.MONGODB_URI);
        const FinancialKillSwitch = require('../models/FinancialKillSwitch');
        
        console.log('Fetching current kill switch state...');
        const beforeState = await FinancialKillSwitch.findOne({ key: 'FINANCIAL' });
        console.log('Before State:', beforeState);
        
        console.log('Restoring system to NORMAL...');
        const afterState = await FinancialKillSwitch.findOneAndUpdate(
            { key: 'FINANCIAL' },
            { enabled: false, reason: 'Restoring normal operations for physical test' },
            { upsert: true, new: true }
        );
        console.log('After State:', afterState);
        
        console.log('Success: Kill switch deactivated.');
        process.exit(0);
    } catch (err) {
        console.error('Failed:', err);
        process.exit(1);
    }
}

deactivate();
