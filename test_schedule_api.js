
const http = require('http');
const https = require('https');

const API_BASE = 'https://khataa-backend.onrender.com/api';

async function request(method, path, body = null, token = null) {
    const url = new URL(API_BASE + path);
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json'
        }
    };
    if (token) {
        options.headers['Authorization'] = 'Bearer ' + token;
    }
    
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch(e) {
                    resolve({ status: res.statusCode, data });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function run() {
    try {
        console.log('1. Creating test users...');
        const ts = Date.now();
        const lenderPhone = '88' + ts.toString().slice(-8);
        const borrowerPhone = '99' + ts.toString().slice(-8);
        
        // We can't easily do OTP flow via API without Firebase.
        // Wait, the backend requires Firebase Auth token for sync-firebase, OR we can use the test bypass if available?
        // Let's check if there's a bypass in auth.js.
    } catch(e) {
        console.error(e);
    }
}
run();

