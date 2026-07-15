const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

console.log('Mounting routes...');
try {
    app.use('/api/auth', require('./routes/auth'));
    console.log('Auth OK');
    app.use('/api/users', require('./routes/users'));
    console.log('Users OK');
    app.use('/api/loans', require('./routes/loans'));
    console.log('Loans OK');
    app.use('/api/credit-score', require('./routes/creditScore'));
    console.log('Credit Score OK');
} catch (e) {
    console.error('FAILED during mounting:');
    console.error(e.stack || e);
    process.exit(1);
}

app.get('/api/test', (req, res) => {
    res.json({ message: 'Server is running' });
});

const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
        console.log('MongoDB Connected');
        app.listen(PORT, () => {
            console.log(`Debug server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Connection error:', err);
        process.exit(1);
    });
