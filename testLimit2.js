const axios = require('axios');
const API_URL = 'https://khataa-backend.onrender.com';
async function test() {
    for(let i=0; i<8; i++) {
        try {
            const res = await axios.post(`${API_URL}/api/auth/login-password`, { phone: "9999999999", password: "wrong" });
            console.log(`Req ${i}: ${res.status}`);
        } catch(e) {
            console.log(`Req ${i}: ${e.response ? e.response.status : e.message}`);
        }
    }
}
test();
