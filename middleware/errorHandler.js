const { getTraceContext } = require('../utils/asyncContext');

function errorHandler(err, req, res, next) {
    try {
        const { requestId } = getTraceContext();
        
        // Default error details
        let status = 500;
        let code = 'INTERNAL_ERROR';
        let message = 'An unexpected error occurred.';

        // Mongoose CastError (Invalid ID or type cast failure)
        if (err.name === 'CastError') {
            status = 400;
            if (err.path === '_id' || err.path === 'id') {
                code = 'INVALID_ID';
                message = 'Invalid resource identifier format.';
            } else {
                code = 'INVALID_FIELD_TYPE';
                message = `Invalid data type for field: ${err.path}.`;
            }
        } 
        // Mongoose ValidationError
        else if (err.name === 'ValidationError') {
            status = 400;
            code = 'VALIDATION_ERROR';
            message = 'Input validation failed. Please check your data.';
        } 
        // MongoDB Duplicate Key Error
        else if (err.code === 11000) {
            status = 409;
            code = 'CONFLICT_ERROR';
            message = 'A resource with that unique constraint already exists.';
        }
        // JWT/Authentication Errors
        else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.message === 'UNAUTHENTICATED') {
            status = 401;
            code = 'AUTHENTICATION_ERROR';
            message = 'Authentication token is invalid or expired.';
        }
        // Authorization Errors
        else if (err.message === 'UNAUTHORIZED' || err.message === 'FORBIDDEN') {
            status = 403;
            code = 'AUTHORIZATION_ERROR';
            message = 'You do not have permission to perform this action.';
        }
        // Business Logic / Custom Errors
        else if (err.message === 'LOAN_NOT_FOUND' || err.message === 'RESOURCE_NOT_FOUND') {
            status = 404;
            code = 'NOT_FOUND';
            message = 'The requested resource could not be found.';
        }
        else if (err.message === 'INVALID_STATE_TRANSITION' || err.message === 'MUTATION_REJECTED') {
            status = 400;
            code = 'LOAN_STATE_INVALID';
            message = 'The requested action cannot be performed in the current state.';
        }
        else if (err.message.includes('INTENT_INVALID_OR_CONSUMED')) {
            status = 400;
            code = 'INTENT_INVALID';
            message = err.message;
        }
        // Custom handled errors that pass a status explicitly (if any)
        else if (err.status) {
            status = err.status;
            code = err.code || 'API_ERROR';
            message = err.message || message;
        }

        // Attach classified code to response locals so requestCorrelation logger can use it
        res.locals.errorCode = code;

        const logPayload = {
            type: 'error',
            errorClass: err.name,
            message: err.message,
            code
        };
        
        if (process.env.NODE_ENV !== 'production' && status >= 500) {
            logPayload.stack = err.stack;
        }
        
        console.error(logPayload);

        res.status(status).json({
            success: false,
            code,
            message,
            requestId
        });
    } catch (loggingErr) {
        // Observability must not crash the app
        console.error('[Error Middleware Fault]', loggingErr.message);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
}

module.exports = errorHandler;