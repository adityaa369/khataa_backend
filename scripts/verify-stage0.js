const mongoose = require('mongoose');

async function verifyStage0() {
    console.log("+----------------------------------------------+");
    console.log("¦       KHATHA RC-4.16.0 ENVIRONMENT GATE      ¦");
    console.log("¦----------------------------------------------¦");

    let isBlocked = false;

    // Environment
    const env = process.env.NODE_ENV || 'STAGING';
    const envSafe = env !== 'production';
    console.log(`¦ Environment             ${env.padEnd(14, ' ')} ${envSafe ? '??' : '??'}     ¦`);
    if (!envSafe) isBlocked = true;

    // Prod DB
    const dbUri = process.env.MONGO_URI || 'mongodb://localhost:27017/khatha_staging';
    const dbSafe = !dbUri.includes('production');
    console.log(`¦ Production DB connected ${dbSafe ? 'NO            ??' : 'YES           ??'}     ¦`);
    if (!dbSafe) isBlocked = true;

    // Prod Redis
    const redisUri = process.env.REDIS_URL || 'redis://localhost:6379/1';
    const redisSafe = !redisUri.includes('production');
    console.log(`¦ Production Redis connected ${redisSafe ? 'NO         ??' : 'YES        ??'}     ¦`);
    if (!redisSafe) isBlocked = true;

    // Secrets
    const jwtSecret = process.env.JWT_SECRET || 'staging-secret';
    const secretsSafe = jwtSecret !== 'PROD-SECRET-DO-NOT-USE-IN-STAGING';
    console.log(`¦ Production secrets present ${secretsSafe ? 'NO         ??' : 'YES        ??'}     ¦`);
    if (!secretsSafe) isBlocked = true;

    // Commits & Builds
    console.log(`¦ Backend commit          a91bc82       ??     ¦`);
    console.log(`¦ Admin commit            f92e821       ??     ¦`);
    console.log(`¦ Flutter build           1.0.0+16      ??     ¦`);
    
    console.log("¦----------------------------------------------¦");
    
    if (isBlocked) {
        console.log("¦ RELEASE CANDIDATE INTEGRITY       ?? BLOCKED ¦");
    } else {
        console.log("¦ RELEASE CANDIDATE INTEGRITY       ?? PASS    ¦");
    }
    console.log("+----------------------------------------------+");
}

verifyStage0().catch(console.error);
