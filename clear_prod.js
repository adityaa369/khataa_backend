const mongoose = require('mongoose');

const MONGO_URI = "mongodb+srv://adityaamruthaluri369_db_user:eQEork9PIDcuuYvV@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0";

async function clearProductionDB() {
    try {
        console.log('Connecting to production MongoDB Atlas database...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected successfully!');

        const collections = await mongoose.connection.db.listCollections().toArray();
        console.log(`Found ${collections.length} collection(s) in database.`);
        
        for (const col of collections) {
            const name = col.name;
            if (name.startsWith('system.')) continue;
            
            const collection = mongoose.connection.db.collection(name);
            const countBefore = await collection.countDocuments({});
            const res = await collection.deleteMany({});
            console.log(`Cleared collection "${name}": deleted ${res.deletedCount} documents (was ${countBefore} documents)`);
        }

        console.log('\n--- Production Database Cleared Successfully! ---');
        process.exit(0);
    } catch (err) {
        console.error('Error during cleanup:', err);
        process.exit(1);
    }
}

clearProductionDB();
