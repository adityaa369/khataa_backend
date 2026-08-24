const mongoose = require('mongoose');
const SecurityEvent = require('./models/SecurityEvent');
const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';
async function run() {
    await mongoose.connect(MONGODB_URI);
    const count = await SecurityEvent.countDocuments({ eventType: 'RATE_LIMIT_EXCEEDED' });
    console.log("RATE_LIMIT_EXCEEDED events:", count);
    process.exit(0);
}
run();
