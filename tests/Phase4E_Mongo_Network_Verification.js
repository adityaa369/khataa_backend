const mongoose = require('mongoose');

async function testExternalMongoConnection() {
    const uri = 'mongodb+srv://adityaamruthaluri369_db_user:eQEork9PIDcuuYvV@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';
    console.log('[Test] Attempting to connect to Atlas cluster from external internet...');
    try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
        console.log('\x1b[31m[FAIL]\x1b[0m External Mongo access is ALLOWED (Connection Succeeded).');
        console.log('       This means the Atlas IP Access List is likely set to 0.0.0.0/0 (Publicly exposed).');
        await mongoose.disconnect();
    } catch (err) {
        if (err.message.includes('bad auth') || err.message.includes('Authentication failed')) {
            console.log('\x1b[33m[WARN]\x1b[0m External connection reached the server, but authentication failed.');
            console.log('       The cluster is still network-accessible from the internet.');
            console.log('Error details:', err);
        } else if (err.message.includes('ECONNREFUSED') || err.message.includes('timeout') || err.message.includes('ENOTFOUND')) {
            console.log('\x1b[32m[PASS]\x1b[0m External Mongo access is DENIED (Connection Failed: ' + err.message + ').');
        } else {
            console.log('\x1b[31m[FAIL]\x1b[0m Connection failed for an unexpected reason: ' + err.message);
        }
    }
}

testExternalMongoConnection().catch(console.error);
