const dotenv = require('dotenv');
dotenv.config();

const keys = Object.keys(process.env).filter(k => k.toLowerCase().includes('mongo') || k.toLowerCase().includes('db') || k.toLowerCase().includes('uri') || k.toLowerCase().includes('url'));
console.log("Matching env vars:", keys);
