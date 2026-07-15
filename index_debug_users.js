const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

console.log('Mounting users route...');
app.use('/api/users', require('./routes/users'));
console.log('Users route mounted.');

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
