const mongoose = require('mongoose');
const SecurityEvent = require('./models/SecurityEvent');

const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';

async function check() {
    await mongoose.connect(MONGODB_URI);
    const count = await SecurityEvent.countDocuments();
    console.log("Total Security Events:", count);
    const events = await SecurityEvent.find();
    console.log(events);
    process.exit(0);
}
check();
