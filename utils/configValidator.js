// utils/configValidator.js
function validateConfig() {
    const requiredVars = [
        'MONGODB_URI',
        'JWT_SECRET',
        'ENCRYPTION_KEY',
        'REDIS_URL'
        // 'FIREBASE_SERVER_KEY' // if mandatory
    ];

    let missing = [];
    for (const key of requiredVars) {
        if (!process.env[key]) missing.push(key);
    }

    if (missing.length > 0) {
        console.error('\n--- FATAL: STARTUP CONFIGURATION VALIDATION FAILED ---');
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        console.error('The application cannot safely receive traffic. Shutting down.\n');
        process.exit(1);
    }

    console.log('\n--- Configuration Validation ---');
    console.log('MongoDB       \u2713');
    console.log('Redis         \u2713');
    console.log('JWT           \u2713');
    console.log('Encryption    \u2713');
    console.log('--------------------------------\n');
}

module.exports = { validateConfig };
