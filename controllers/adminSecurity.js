const SecurityEvent = require('../models/SecurityEvent');
const User = require('../models/User');

exports.getSecurityOverview = async (req, res) => {
    const events = await SecurityEvent.aggregate([
        { $group: { _id: "$eventType", count: { $sum: 1 } } }
    ]);
    
    const blockedCount = await SecurityEvent.countDocuments({ result: 'BLOCKED' });
    const criticalCount = await SecurityEvent.countDocuments({ severity: 'CRITICAL' });
    
    res.status(200).json({
        success: true,
        data: {
            authFailures: events.find(e => e._id === 'AUTH_FAILED')?.count || 0,
            otpReplays: events.find(e => e._id === 'OTP_REPLAY')?.count || 0,
            rateLimits: events.find(e => e._id === 'RATE_LIMIT_EXCEEDED')?.count || 0,
            suspiciousSessions: events.find(e => e._id === 'SUSPICIOUS_SESSION')?.count || 0,
            blockedRequests: blockedCount,
            criticalIncidents: criticalCount
        }
    });
};

exports.getSecurityEvents = async (req, res) => {
    // Read-only Admin API
    const events = await SecurityEvent.find().sort({ createdAt: -1 }).limit(100);
    // Ensure absolutely no raw sensitive identifiers are sent (though not stored here anyway)
    res.status(200).json({ success: true, data: events });
};

exports.investigateSecurityEvents = async (req, res) => {
    try {
        const { query, type, time, severity, financialImpact } = req.query;
        let filter = {};

        // 1. Time Filter
        if (time && time !== 'All') {
            const now = new Date();
            if (time === '1h') filter.createdAt = { $gte: new Date(now - 60 * 60 * 1000) };
            if (time === '24h') filter.createdAt = { $gte: new Date(now - 24 * 60 * 60 * 1000) };
            if (time === '7d') filter.createdAt = { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) };
        }

        // 2. Explicit Selectors
        if (type && type !== 'All') filter.eventType = type;
        if (severity && severity !== 'All') filter.severity = severity;
        if (financialImpact && financialImpact !== 'All') filter.financialImpact = financialImpact;

        // 3. Identity & Resource Search (Broad ID matching without regex to ensure index use)
        if (query) {
            const q = query.trim();
            filter.$or = [
                { eventId: q },
                { requestId: q },
                { actorId: q },
                { resourceId: q },
                { 'metadata.loanId': q },
                { 'metadata.transactionId': q },
                { 'metadata.chitId': q },
                { 'metadata.userId': q },
                { 'metadata.actionType': q }
            ];
        }

        // Enforce Read-Only Investigation Rule: Limit results to prevent massive unindexed scans pulling down the DB
        const events = await SecurityEvent.find(filter).sort({ createdAt: -1 }).limit(200);
        
        res.status(200).json({ success: true, data: events });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};
