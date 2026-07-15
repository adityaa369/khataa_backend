const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = 5000;
const MONGO_URI = "mongodb+srv://adityaamruthaluri369_db_user:eQEork9PIDcuuYvV@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0";

// Minimal User Model
const User = mongoose.model('User', new mongoose.Schema({
    id: String,
    phone: String,
    firstName: String,
    lastName: String
}));

app.get('/api/test', (req, res) => res.json({ success: true, message: 'Server is Live!' }));

app.get('/api/users/profile', async (req, res) => {
    res.json({ success: true, user: { id: 'test', phone: '911234567890' } });
});

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('Final Backend Connected to MongoDB');
        app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
    })
    .catch(err => console.error(err));
