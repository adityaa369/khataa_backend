const crypto = require('crypto');

function errorHandler(err, req, res, next) {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    
    // Default error details
    let status = 500;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected error occurred.';

    // Safe error logging
    const logPayload = {
        requestId,
        route: req.originalUrl,
        method: req.method,
        user: req.user ? req.user.id : 'unauthenticated',
        errorClass: err.name,
        stack: err.stack,
        message: err.message
    };
    
    // Do not log sensitive payloads
    console.error('[Error Middleware]', JSON.stringify(logPayload));

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
        code = 'DUPLICATE_RESOURCE';
        message = 'A resource with that unique constraint already exists.';
    }
    // JWT/Authentication Errors
    else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.message === 'UNAUTHENTICATED') {
        status = 401;
        code = 'UNAUTHENTICATED';
        message = 'Authentication token is invalid or expired.';
    }
    // Authorization Errors
    else if (err.message === 'UNAUTHORIZED' || err.message === 'FORBIDDEN') {
        status = 403;
        code = 'FORBIDDEN';
        message = 'You do not have permission to perform this action.';
    }
    // Business Logic / Custom Errors
    else if (err.message === 'LOAN_NOT_FOUND' || err.message === 'RESOURCE_NOT_FOUND') {
        status = 404;
        code = 'RESOURCE_NOT_FOUND';
        message = 'The requested resource could not be found.';
    }
    else if (err.message === 'INVALID_STATE_TRANSITION' || err.message === 'MUTATION_REJECTED') {
        status = 400;
        code = 'MUTATION_REJECTED';
        message = 'The requested action cannot be performed in the current state.';
    }
    // Custom handled errors that pass a status explicitly (if any)
    else if (err.status) {
        status = err.status;
        code = err.code || 'API_ERROR';
        message = err.message || message;
    }

    res.status(status).json({
        success: false,
        code,
        message,
        requestId
    });
}

module.exports = errorHandler;
