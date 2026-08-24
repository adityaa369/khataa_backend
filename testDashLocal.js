const axios = require('axios');
const jwt = require('jsonwebtoken');
const token = jwt.sign({ adminId: 'dummy', role: 'OPERATOR', mfaVerified: true }, '1be3118c693f296ea3f5f1d57b878a88bd81b53f3a086f1e33823a96b4dc4424', { expiresIn: '1h' });

async function test() {
    try {
        const res = await axios.get('http://localhost:5000/api/admin/dashboard', { headers: { Authorization: `Bearer ${token}` } });
        console.log("Dashboard OK:", res.status);
    } catch(e) {
        console.error("Dashboard Failed:", e.response ? e.response.status : e.message);
    }
}
test();
