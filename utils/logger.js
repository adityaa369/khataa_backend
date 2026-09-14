// utils/logger.js
const { getTraceContext } = require('./asyncContext');

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

const SENSITIVE_KEYS = [
    'pan', 'aadhar', 'password', 'otp', 'token', 'jwt', 'secret', 
    'authorization', 'cookie', 'biometric', 'documenturl', 'credentials',
    'base64'
];

// Patterns for values that should be redacted regardless of key
const VALUE_PATTERNS = [
    // Matches Firebase Storage signed URLs
    /storage\.googleapis\.com.*GoogleAccessId=/i,
    // Matches base64 data URIs
    /^data:image\/[a-z]+;base64,/i,
    // Very long base64-like strings (heuristics for raw base64 payloads)
    /^(?:[A-Za-z0-9+/]{4}){100,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
];

const redactString = (str) => {
    for (const pattern of VALUE_PATTERNS) {
        if (pattern.test(str)) {
            return '[REDACTED_SENSITIVE_PATTERN]';
        }
    }
    return str;
};

const redact = (obj) => {
    if (obj instanceof Error) {
        return { message: obj.message, stack: obj.stack, code: obj.code };
    }
    if (typeof obj === 'string') {
        // Attempt to parse stringified JSON first
        if ((obj.startsWith('{') && obj.endsWith('}')) || (obj.startsWith('[') && obj.endsWith(']'))) {
            try {
                const parsed = JSON.parse(obj);
                return JSON.stringify(redact(parsed));
            } catch (e) {
                return redactString(obj);
            }
        }
        return redactString(obj);
    }
    if (typeof obj !== 'object' || obj === null) return obj;
    
    let redacted = Array.isArray(obj) ? [] : {};
    for (let key in obj) {
        if (typeof key === 'string' && SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k))) {
            redacted[key] = '[REDACTED]';
        } else {
            redacted[key] = redact(obj[key]);
        }
    }
    return redacted;
};

const formatStructuredLog = (level, args) => {
    // If the only argument is an object (like accessLog), merge it at the root
    let payload;
    let rootAttributes = {};
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        payload = redact(args[0]);
        // If it's a structured access log, extract its properties
        if (payload.type === 'access' || payload.type === 'error') {
            rootAttributes = payload;
            payload = undefined;
        }
    } else {
        payload = args.map(arg => typeof arg === 'object' ? redact(arg) : redactString(arg)).join(' ');
    }

    const { requestId, userId, intentId, loanId, idempotencyKey, transactionId } = getTraceContext();
    
    const logObj = {
        timestamp: new Date().toISOString(),
        level,
        requestId,
        userId,
        ...rootAttributes
    };
    
    if (intentId) logObj.intentId = intentId;
    if (loanId) logObj.loanId = loanId;
    if (idempotencyKey) logObj.idempotencyKey = idempotencyKey;
    if (transactionId) logObj.transactionId = transactionId;
    if (payload !== undefined) logObj.message = payload;

    return JSON.stringify(logObj);
};

module.exports = {
    log: (...args) => {
        process.stdout.write(formatStructuredLog('INFO', args) + '\n');
    },
    info: (...args) => {
        process.stdout.write(formatStructuredLog('INFO', args) + '\n');
    },
    error: (...args) => {
        process.stderr.write(formatStructuredLog('ERROR', args) + '\n');
    },
    warn: (...args) => {
        process.stdout.write(formatStructuredLog('WARN', args) + '\n');
    }
};