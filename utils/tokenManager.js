const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Session = require('../models/Session');

class TokenManager {
    /**
     * Generates a short-lived Access Token
     */
    static generateAccessToken(userId) {
        return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
            expiresIn: '15m' // Short lifetime for security
        });
    }

    /**
     * Generates a secure random refresh token (opaque string)
     */
    static generateRefreshToken() {
        return crypto.randomBytes(40).toString('hex');
    }

    /**
     * Hashes a refresh token for safe database storage
     */
    static hashRefreshToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    /**
     * Creates a new session and returns the AT/RT pair
     */
    static async createSession(userId, deviceInfo, ipAddress) {
        const accessToken = this.generateAccessToken(userId);
        const refreshToken = this.generateRefreshToken();
        const refreshTokenHash = this.hashRefreshToken(refreshToken);

        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

        const session = await Session.create({
            userId,
            refreshTokenHash,
            deviceInfo: deviceInfo || 'Unknown Device',
            ipAddress,
            expiresAt
        });

        return {
            accessToken,
            refreshToken, // Send to client ONCE
            sessionId: session._id
        };
    }
}

module.exports = TokenManager;
