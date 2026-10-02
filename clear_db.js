const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

// Default to the provided env var, but allow passing it directly if needed
const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI) {
    console.error("ERROR: No MONGODB_URI found in .env");
    console.error("Please add your Atlas URI to the .env file.");
    process.exit(1);
}

const clearDB = async () => {
    try {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(MONGO_URI);
        console.log(`Connected to Database: ${mongoose.connection.db.databaseName}`);

        // FIX: Previously this used mongoose.connection.collections without loading models,
        // which resulted in an empty array. We now query the native MongoDB driver directly.
        const collections = await mongoose.connection.db.listCollections().toArray();
        
        console.log(`Found ${collections.length} collections. Clearing data...`);
        let totalDeleted = 0;

        for (const collInfo of collections) {
            const name = collInfo.name;
            if (name.startsWith('system.')) continue;

            const collection = mongoose.connection.db.collection(name);
            const countBefore = await collection.countDocuments();
            
            await collection.deleteMany({});
            
            const countAfter = await collection.countDocuments();
            totalDeleted += countBefore;
            
            console.log(` - ${name}: deleted ${countBefore} documents.`);
        }

        console.log(`\nSuccessfully deleted ${totalDeleted} documents from all collections.`);
        console.log("Schema and indexes have been preserved.");
        process.exit(0);
    } catch (err) {
        console.error("Error clearing DB:", err);
        process.exit(1);
    }
};

clearDB();
