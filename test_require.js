try {
    console.log('Testing requires...');

    const modules = [
        'express',
        'dotenv',
        'cors',
        'morgan',
        'mongoose',
        './config/db',
        './models/User',
        './models/Loan',
        './models/CreditScore',
        './controllers/auth',
        './controllers/loans',
        './routes/auth',
        './routes/users',
        './routes/loans',
        './routes/creditScore',
        './index.js'
    ];

    for (const mod of modules) {
        try {
            console.log(`Loading ${mod}...`);
            require(mod);
            console.log(`  ${mod} OK`);
        } catch (e) {
            console.error(`  FAILED to load ${mod}`);
            console.error(e.stack || e);
            process.exit(1);
        }
    }

    console.log('\nAll requires passed!');
} catch (err) {
    console.error('CRITICAL ERROR:');
    console.error(err);
    process.exit(1);
}
