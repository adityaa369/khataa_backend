const axios = require('axios');

async function checkIP() {
    try {
        console.log('Checking your external IP address...');
        const response = await axios.get('https://api.ipify.org?format=json');
        console.log('\n--- Your External IP Address ---');
        console.log(response.data.ip);
        console.log('------------------------------');
        console.log('\nCopy this IP and add it to your MongoDB Atlas "Network Access" white list:');
        console.log('https://cloud.mongodb.com/');
    } catch (err) {
        console.error('Error fetching IP:', err.message);
    }
}

checkIP();
