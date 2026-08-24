const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';

async function check() {
    await mongoose.connect(MONGODB_URI);
    const SecurityEvent = mongoose.model('SecurityEvent', new mongoose.Schema({ eventType: String, result: String, metadata: Object }, { strict: false }));
    const events = await SecurityEvent.find({ eventType: { $in: ['KILL_SWITCH_ACTIVATED', 'KILL_SWITCH_DEACTIVATED', 'FINANCIAL_KILL_SWITCH_BLOCKED'] } }).sort({ createdAt: -1 }).limit(10);
    events.forEach(e => {
        console.log(`[${e.eventType}] Result: ${e.result}, Meta:`, e.metadata);
    });
    process.exit(0);
}
check();
