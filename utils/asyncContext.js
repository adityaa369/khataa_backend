const { AsyncLocalStorage } = require('node:async_hooks');
const asyncLocalStorage = new AsyncLocalStorage();

module.exports = {
    asyncLocalStorage,
    getTraceContext: () => {
        const store = asyncLocalStorage.getStore();
        return store ? store : { requestId: 'UNKNOWN', userId: 'ANONYMOUS' };
    }
};
