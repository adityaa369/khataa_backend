const mongoose = require('mongoose');
const { triggerAlert } = require('./utils/telemetry');
const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';

async function test() {
    await mongoose.connect(MONGODB_URI);
    try {
        triggerAlert('TEST_EVENT', 'LOW', { message: 'hello' });
    } catch(e) {
        console.error("Error triggering alert:", e);
    }
    await new Promise(r => setTimeout(r, 2000));
    const SecurityEvent = require('./models/SecurityEvent');
    const ev = await SecurityEvent.findOne({ eventType: 'TEST_EVENT' });
    console.log("Event:", ev);
    process.exit(0);
}
test();
