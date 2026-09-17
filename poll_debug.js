
const https = require('https');

function fetch() {
    https.get('https://khataa-backend.onrender.com/api/loans/6aaa9f354a72eec9ea0f8c62/debug-schedule', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            if (res.statusCode === 200) {
                console.log(JSON.stringify(JSON.parse(data), null, 2));
                process.exit(0);
            } else {
                console.log('Status: ' + res.statusCode);
                setTimeout(fetch, 5000);
            }
        });
    }).on('error', (e) => {
        console.error(e);
        setTimeout(fetch, 5000);
    });
}
fetch();

