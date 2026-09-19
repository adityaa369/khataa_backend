const NotificationOutbox = require('../models/NotificationOutbox');
const { v4: uuidv4 } = require('uuid');

class EventDispatcher {
    /**
     * Dispatch a canonical domain event to the Notification Outbox.
     * Generates independent outbox entries for each specified channel (e.g., PUSH, IN_APP, EMAIL).
     * 
     * @param {Object} params
     * @param {string} params.eventType - Canonical event type (from NotificationEvents.js)
     * @param {string} params.aggregateType - Type of domain entity (e.g., 'LOAN', 'PAYMENT', 'USER')
     * @param {string} params.aggregateId - ID of the domain entity (e.g., loan._id.toString())
     * @param {string} params.recipientUserId - The user who should receive the notification
     * @param {Object} params.payload - Safe, non-sensitive data payload for the notification templates/deep links
     * @param {Array<string>} [params.channels=['PUSH', 'IN_APP']] - Delivery channels
     * @param {string} [params.idempotencyKey] - Custom key to prevent duplicate dispatches (e.g. intentId)
     * @param {mongoose.ClientSession} [params.session] - MongoDB transaction session for ACID guarantees
     */
    static async dispatch({
        eventType,
        aggregateType,
        aggregateId,
        recipientUserId,
        payload,
        channels = ['PUSH', 'IN_APP'],
        idempotencyKey = null,
        session = null
    }) {
        const rootEventId = idempotencyKey || uuidv4();
        
        const outboxEntries = channels.map(channel => ({
            eventId: `${rootEventId}_${channel}`, // Unique per channel
            aggregateType,
            aggregateId,
            eventType,
            recipientUserId,
            channel,
            payload,
            status: 'PENDING'
        }));

        const options = { ordered: false };
        if (session) {
            options.session = session;
        }

        try {
            await NotificationOutbox.insertMany(outboxEntries, options);
        } catch (error) {
            // Error code 11000 is a Duplicate Key Error.
            // When ordered: false is used, MongoDB throws an error if ANY document fails,
            // but successfully inserts the non-duplicate ones.
            // If the failure is purely due to duplicate keys (idempotency hit), we gracefully ignore it.
            if (error.code === 11000 || (error.writeErrors && error.writeErrors.every(e => e.code === 11000))) {
                console.log(`[EventDispatcher] Duplicate event suppressed (Idempotency Key: ${rootEventId})`);
                return;
            }
            console.error('[EventDispatcher] Failed to dispatch event:', error);
            throw error;
        }
    }
}

module.exports = EventDispatcher;
