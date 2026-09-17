const NotificationOutbox = require('../models/NotificationOutbox');
const { sendPushNotification } = require('./fcm');
const { sendEmail } = require('./email');

async function processOutboxEvents() {
    try {
        // Find pending events and mark them as processing atomically
        const events = await NotificationOutbox.find({ status: 'PENDING', nextRetryAt: { $lte: new Date() } }).limit(10);
        
        for (const event of events) {
            event.status = 'PROCESSING';
            await event.save();
            
            try {
                if (event.channel === 'PUSH') {
                    if (event.payload && event.payload.fcmToken) {
                        await sendPushNotification(
                            event.payload.fcmToken,
                            event.payload.title,
                            event.payload.body,
                            event.payload.data
                        );
                    }
                } else if (event.channel === 'EMAIL') {
                    // Implement email if needed
                }
                
                event.status = 'SENT';
                event.sentAt = new Date();
                await event.save();
            } catch (err) {
                console.error('[OutboxProcessor] Error processing event:', event._id, err.message);
                event.retryCount += 1;
                event.lastError = err.message;
                if (event.retryCount >= 3) {
                    event.status = 'DEAD_LETTER';
                } else {
                    event.status = 'PENDING';
                    // Exponential backoff
                    event.nextRetryAt = new Date(Date.now() + Math.pow(2, event.retryCount) * 1000 * 60);
                }
                await event.save();
            }
        }
    } catch (err) {
        console.error('[OutboxProcessor] Global error:', err.message);
    }
}

exports.processOutboxEvents = processOutboxEvents;
