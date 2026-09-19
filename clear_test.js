const mongoose = require('mongoose');
const MONGO_URI = "mongodb+srv://khatha_user:yP3fH9Xf8C@cluster0.b73r74l.mongodb.net/khatha?retryWrites=true&w=majority";
async function run() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Connected.");
        process.exit(0);
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
}
run();
