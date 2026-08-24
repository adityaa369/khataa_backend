const axios = require('axios');
async function test() {
    try {
        const res = await axios.post('https://khataa-backend.onrender.com/api/auth/login-password', { phone: "9999999999", password: "wrong" });
        console.log(res.headers);
    } catch(e) {
        console.log(e.response.headers);
        console.log(e.response.data);
    }
}
test();
