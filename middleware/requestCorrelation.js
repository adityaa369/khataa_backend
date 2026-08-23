const { v4: uuidv4 } = require('uuid');
const { asyncLocalStorage } = require('../utils/asyncContext');

module.exports = (req, res, next) => {
    const requestId = req.headers['x-request-id'] || uuidv4();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    
    // Create a new async context for this request
    const store = {
        requestId,
        userId: 'ANONYMOUS' // Will be populated by auth middleware
    };

    asyncLocalStorage.run(store, () => {
        next();
    });
};
