const crypto = require('crypto');

// Ensure this is securely set in .env in production (32 bytes)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex').substring(0, 32);

// Robustly derive exactly 32 bytes from whatever string the environment provides
let keyBuffer;
if (ENCRYPTION_KEY.length === 64 && /^[0-9a-fA-F]+$/.test(ENCRYPTION_KEY)) {
    // 64-character hex string = 32 bytes
    keyBuffer = Buffer.from(ENCRYPTION_KEY, 'hex');
} else if (Buffer.byteLength(ENCRYPTION_KEY, 'utf8') === 32) {
    // Exactly 32 bytes as a string
    keyBuffer = Buffer.from(ENCRYPTION_KEY, 'utf8');
} else {
    // Any other length: securely hash it to force exactly 32 bytes (SHA-256)
    keyBuffer = crypto.createHash('sha256').update(String(ENCRYPTION_KEY)).digest();
}

const IV_LENGTH = 12; // GCM optimal IV length is 12 bytes
const AUTH_TAG_LENGTH = 16;

class EncryptionUtil {
    static encrypt(text) {
        if (!text) return text;
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
        
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag().toString('hex');
        
        // Format: iv:authTag:ciphertext
        return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    }

    static decrypt(text) {
        if (!text) return text;
        // Legacy data check
        if (!text.includes(':')) return text; 

        try {
            const parts = text.split(':');
            
            if (parts.length === 2) {
                console.warn('[EncryptionUtil] Legacy AES-256-CBC data encountered.');
                return null;
            }

            const iv = Buffer.from(parts[0], 'hex');
            const authTag = Buffer.from(parts[1], 'hex');
            const encryptedText = parts[2];
            
            const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
            decipher.setAuthTag(authTag);
            
            let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            console.error('[EncryptionUtil] Integrity check failed or corruption detected.');
            return null; 
        }
    }
}

module.exports = EncryptionUtil;
