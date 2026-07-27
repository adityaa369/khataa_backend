const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI) {
    console.error("No MONGODB_URI found in .env");
    process.exit(1);
}

const clearDB = async () => {
    try {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(MONGO_URI);
        console.log("Connected to MongoDB Atlas.");

        const collections = mongoose.connection.collections;
        
        console.log("Clearing all collections...");
        for (const key in collections) {
            const collection = collections[key];
            await collection.deleteMany();
            console.log(`Cleared ${collection.name}`);
        }

        console.log("Successfully cleared all data from the database.");
        process.exit(0);
    } catch (err) {
        console.error("Error clearing DB:", err);
        process.exit(1);
    }
};

clearDB();
