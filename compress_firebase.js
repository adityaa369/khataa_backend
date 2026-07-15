const fs = require('fs');

try {
    const rawData = fs.readFileSync('c:\\Users\\adity\\Downloads\\khaata-42b18-firebase-adminsdk-fbsvc-7ba015f62d.json', 'utf8');
    const parsed = JSON.parse(rawData);
    const stringified = JSON.stringify(parsed);

    // Save to a text file for the user to easily copy
    fs.writeFileSync('./firebase_env_value.txt', stringified);
    console.log('Successfully compressed Firebase JSON to firebase_env_value.txt');
} catch (e) {
    console.error('Error compressing JSON:', e);
}
