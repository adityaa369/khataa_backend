/**
 * Money Standardization Utility
 * Fintech applications must NEVER use floating-point math for financial values.
 * All monetary values must be stored, transferred, and calculated in their smallest unit (Paise for INR).
 */

class Money {
    /**
     * Converts a Rupee value (float/double) to Paise (Integer)
     * e.g., 50.50 -> 5050
     */
    static toPaise(rupees) {
        if (rupees === null || rupees === undefined || isNaN(rupees)) {
            throw new Error('Invalid money amount provided');
        }
        // Math.round prevents 0.1 + 0.2 = 0.30000000000000004 issues
        return Math.round(parseFloat(rupees) * 100);
    }

    /**
     * Converts a Paise value (Integer) to Rupees (Float)
     * e.g., 5050 -> 50.50
     */
    static toRupees(paise) {
        if (!Number.isInteger(paise)) {
            throw new Error('Paise must be an integer');
        }
        return paise / 100;
    }

    /**
     * Safely allocate a sum of money among N parties without losing a penny.
     * Useful for dividing a Chit Fund dividend where 10000 paise / 3 members = 3333.333...
     * Returns an array of integers: [3334, 3333, 3333]
     */
    static allocate(paiseAmount, parties) {
        if (!Number.isInteger(paiseAmount)) throw new Error('Amount must be an integer (paise)');
        if (parties <= 0) throw new Error('Parties must be > 0');

        const baseShare = Math.floor(paiseAmount / parties);
        const remainder = paiseAmount % parties;
        
        const shares = Array(parties).fill(baseShare);
        for (let i = 0; i < remainder; i++) {
            shares[i]++;
        }
        return shares;
    }
}

module.exports = Money;
