const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

// HARDCODED FOR DEBUGGING
process.env.MONGODB_URI = "mongodb+srv://adityaamruthaluri369_db_user:eQEork9PIDcuuYvV@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0";
process.env.JWT_SECRET = "f98a2c3b4d5e6f7g8h9i0j1k2l3m4n5o";
process.env.PORT = "5000";

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log(`MongoDB Connected`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};

connectDB();

const app = express();
app.use(bodyParser.json());
app.use(cors());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/loans', require('./routes/loans'));
app.use('/api/credit-score', require('./routes/creditScore'));

app.get('/api/test', (req, res) => res.json({ message: 'Success' }));

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
