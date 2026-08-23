// utils/logger.js
const { getTraceContext } = require('./asyncContext');

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

const SENSITIVE_KEYS = ['pan', 'aadhar', 'password', 'otp', 'token', 'jwt', 'secret', 'authorization'];

const redact = (obj) => {
    if (obj instanceof Error) {
        return { message: obj.message, stack: obj.stack };
    }
    if (typeof obj !== 'object' || obj === null) return obj;
    let redacted = Array.isArray(obj) ? [] : {};
    for (let key in obj) {
        if (SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k))) {
            redacted[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object') {
            redacted[key] = redact(obj[key]);
        } else {
            redacted[key] = obj[key];
        }
    }
    return redacted;
};

const formatStructuredLog = (level, args) => {
    const { requestId, userId } = getTraceContext();
    const payload = args.map(arg => typeof arg === 'object' ? JSON.stringify(redact(arg)) : arg).join(' ');
    
    return JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        requestId,
        userId,
        message: payload
    });
};

module.exports = {
    log: (...args) => {
        if (process.env.NODE_ENV === 'production') {
            process.stdout.write(formatStructuredLog('INFO', args) + '\n');
        } else {
            originalLog(...args);
        }
    },
    error: (...args) => {
        if (process.env.NODE_ENV === 'production') {
            process.stderr.write(formatStructuredLog('ERROR', args) + '\n');
        } else {
            originalError(...args);
        }
    },
    warn: (...args) => {
        if (process.env.NODE_ENV === 'production') {
            process.stdout.write(formatStructuredLog('WARN', args) + '\n');
        } else {
            originalWarn(...args);
        }
    }
};


