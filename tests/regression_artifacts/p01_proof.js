const admin = require('firebase-admin');

console.log('firebase-admin version: 13.7.0 (from manual package.json check)');
console.log('typeof admin.apps:', typeof admin.apps);
console.log('Is Array?', Array.isArray(admin.apps));
console.log('admin.apps length:', admin.apps ? admin.apps.length : 'undefined');

try {
    if (!admin.apps.length) {
        console.log('Successfully evaluated !admin.apps.length without throwing');
    }
} catch (err) {
    console.error('Threw on !admin.apps.length:', err.message);
}
