const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    max: 1,
    handler: (req, res, next, options) => {
        console.log("OPTIONS:", options);
    }
});
limiter({ ip: '1.2.3.4', headers: {} }, { setHeader: () => {}, status: () => ({ send: () => {}, json: () => {} }) }, () => {});
limiter({ ip: '1.2.3.4', headers: {} }, { setHeader: () => {}, status: () => ({ send: () => {}, json: () => {} }) }, () => {});
