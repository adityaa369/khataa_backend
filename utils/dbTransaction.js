const mongoose = require('mongoose');

/**
 * MongoDB ACID Transaction Helper with Transient Retry Support
 * Wraps operations in a Mongoose session and automatically retries
 * on TransientTransactionError (e.g., WriteConflicts).
 * 
 * @param {Function} work - Async function that takes a (session) and performs operations
 * @param {Number} maxRetries - Maximum number of times to retry
 * @returns {Promise<any>} - The result of the work function
 */
async function withTransaction(work, maxRetries = 3) {
    let attempt = 1;
    while (attempt <= maxRetries) {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const result = await work(session);
            
            // Attempt to commit
            try {
                await session.commitTransaction();
                return result; // Success
            } catch (commitErr) {
                if (commitErr.hasErrorLabel && commitErr.hasErrorLabel('UnknownTransactionCommitResult')) {
                    console.warn(`[Transaction] UnknownTransactionCommitResult on attempt ${attempt}. Retrying...`);
                    // This error label means we don't know if the commit succeeded or failed, 
                    // but for idempotent operations, it's safe to retry.
                    throw commitErr;
                } else if (commitErr.hasErrorLabel && commitErr.hasErrorLabel('TransientTransactionError')) {
                    console.warn(`[Transaction] TransientTransactionError (WriteConflict) on commit. Attempt ${attempt}. Retrying...`);
                    throw commitErr;
                } else {
                    throw commitErr; // A non-transient error during commit
                }
            }
        } catch (error) {
            await session.abortTransaction();
            
            // Check if the error itself (before commit) was transient
            if (error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError') && attempt < maxRetries) {
                console.warn(`[Transaction] TransientTransactionError (WriteConflict) during execution. Attempt ${attempt}. Retrying...`);
                attempt++;
                // Wait briefly before retrying to let the conflicting transaction finish
                await new Promise(res => setTimeout(res, 50 * attempt));
            } else {
                throw error; // Re-throw fatal errors or if out of retries
            }
        } finally {
            session.endSession();
        }
    }
}

module.exports = { withTransaction };
