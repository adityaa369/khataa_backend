const mongoose = require('mongoose');
const User = require('./models/User');
const Loan = require('./models/Loan');
const CreditScore = require('./models/CreditScore');

const MONGO_URI = "mongodb+srv://adityaamruthaluri369_db_user:eQEork9PIDcuuYvV@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0";

async function clearProductionDB() {
    try {
        console.log('Connecting to production MongoDB Atlas database...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected successfully!');

        // Count items before deleting
        const userCount = await User.countDocuments({});
        const loanCount = await Loan.countDocuments({});
        const scoreCount = await CreditScore.countDocuments({});
        console.log(`Current counts before deletion: Users: ${userCount}, Loans: ${loanCount}, CreditScores: ${scoreCount}`);

        console.log('Wiping customer data...');
        const userRes = await User.deleteMany({});
        const loanRes = await Loan.deleteMany({});
        const scoreRes = await CreditScore.deleteMany({});

        console.log(`Wipe completed! Deleted Users: ${userRes.deletedCount}, Deleted Loans: ${loanRes.deletedCount}, Deleted CreditScores: ${scoreRes.deletedCount}`);
        console.log('\n--- Production Database Customer Data Cleared Successfully! ---');
        
        process.exit(0);
    } catch (err) {
        console.error('Error during cleanup:', err);
        process.exit(1);
    }
}

clearProductionDB();
