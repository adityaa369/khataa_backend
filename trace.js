console.log('1. Starting...');
const express = require('express');
console.log('2. express loaded');
const dotenv = require('dotenv');
console.log('3. dotenv loaded');
const cors = require('cors');
console.log('4. cors loaded');
const mongoose = require('mongoose');
console.log('5. mongoose loaded');

dotenv.config();
console.log('6. dotenv.config() called');

const app = express();
console.log('7. express() called');
app.use(cors());
console.log('8. app.use(cors()) called');
app.use(express.json());
console.log('9. app.use(json()) called');

console.log('10. Mounting routes...');
app.use('/api/auth', require('./routes/auth'));
console.log('11. Auth OK');
app.use('/api/users', require('./routes/users'));
console.log('12. Users OK');
app.use('/api/loans', require('./routes/loans'));
console.log('13. Loans OK');
app.use('/api/credit-score', require('./routes/creditScore'));
console.log('14. Credit Score OK');

const PORT = process.env.PORT || 5000;
console.log('15. Port set to', PORT);

mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
        console.log('16. MongoDB Connected');
        app.listen(PORT, () => {
            console.log(`17. Debug server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Connection error:', err);
        process.exit(1);
    });
