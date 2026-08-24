const { getDashboard } = require('./controllers/admin');
const req = {};
const res = {
    status: function(code) { return this; },
    json: function(obj) { console.log(JSON.stringify(obj, null, 2)); }
};
const mockMongo = { connection: { readyState: 0 } };
require.cache[require.resolve('mongoose')] = { exports: mockMongo };
require.cache[require.resolve('../config/redis')] = { exports: { getRedisClient: () => {}, isRedisAvailable: () => false } };
require.cache[require.resolve('../models/ReconciliationIncident')] = { exports: { aggregate: async () => [] } };
require.cache[require.resolve('../middleware/metrics')] = { exports: { getMetricsSnapshot: () => ({}) } };

getDashboard(req, res).catch(console.error);
