const mongoose = require('mongoose');
const User = require('./models/User');
const Loan = require('./models/Loan');
const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';

async function run() {
    await mongoose.connect(MONGODB_URI);
    const loan = await Loan.findOne({ status: 'ACTIVE' });
    if(loan) {
        console.log("Found active loan:", loan._id, "Balance:", loan.remainingAmountPaise, "UserId:", loan.userId);
    } else {
        console.log("No active loan in DB.");
    }
    process.exit(0);
}
run();
