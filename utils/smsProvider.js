/**
 * SMS Provider Interface for Transactional Delivery
 * Must be configured via environment variables.
 */

class SmsProvider {
    /**
     * Send a transactional SMS
     * @param {string} phone - Target phone number
     * @param {string} otp - The plaintext OTP to send
     * @param {number} amountPaise - The transaction amount for context
     * @returns {Promise<{success: boolean, providerMessageId?: string, error?: string, rawResponse?: any}>}
     */
    static async sendTransactionalOtp(phone, otp, amountPaise) {
        // We do not hardcode a provider here. 
        // This is a stub that should be replaced with an actual provider (e.g. SNS, Twilio, MSG91) 
        // once production credentials are provided.
        
        const amountStr = (amountPaise / 100).toFixed(2);
        const message = `Your Khataa payment authorization OTP for ₹${amountStr} is ${otp}.`;

        if (process.env.NODE_ENV !== 'production') {
            console.log(`\n=== [DEV SMS] ===`);
            console.log(`To: ${phone}`);
            console.log(`Message: ${message}`);
            console.log(`=================\n`);
            return { success: true, providerMessageId: 'mock-msg-id' };
        }

        // Implementation hook for production provider:
        const activeProvider = process.env.SMS_PROVIDER;
        
        if (!activeProvider) {
            console.error('[SmsProvider] No SMS_PROVIDER configured in environment');
            return { success: false, error: 'SMS_PROVIDER not configured' };
        }
        
        // Example integration point for the eventual provider
        try {
            // await actualProvider.send(...)
            throw new Error(`Provider ${activeProvider} is configured but not implemented yet.`);
        } catch (error) {
            console.error('[SmsProvider] Delivery failed:', error.message);
            return { success: false, error: error.message };
        }
    }
}

module.exports = SmsProvider;
