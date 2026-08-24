const Loan = require('../models/Loan');
const SecurityEvent = require('../models/SecurityEvent');
const ReconciliationIncident = require('../models/ReconciliationIncident');
const LedgerEntry = require('../models/LedgerEntry');
const { getMetricsSnapshot } = require('../middleware/metrics');

// Helper to provide standard metadata
const getMeta = (source, window = '24h') => ({
    lastVerifiedAt: new Date().toISOString(),
    source,
    window
});

exports.getPaymentsOverview = async (req, res) => {
    try {
        const timeWindow = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h

        // Historical Truth (MongoDB)
        const [committedCount, rejectedCount, loanAgg] = await Promise.all([
            SecurityEvent.countDocuments({ eventType: 'LOAN_PAYMENT_COMMITTED', createdAt: { $gte: timeWindow } }),
            SecurityEvent.countDocuments({ eventType: 'OVERPAYMENT_ATTEMPT', createdAt: { $gte: timeWindow } }), // e.g., rejected payments
            Loan.aggregate([
                { $match: { updatedAt: { $gte: timeWindow } } },
                { $unwind: "$transactions" },
                { 
                    $match: { 
                        "transactions.type": { $in: ["payment", "interest_payment"] },
                        "transactions.recordedAt": { $gte: timeWindow }
                    } 
                },
                { $group: { _id: null, volume: { $sum: "$transactions.amountPaise" } } }
            ])
        ]);

        const historicalVolumePaise = loanAgg.length > 0 ? loanAgg[0].volume : 0;

        // Live Process Telemetry
        const processMetrics = getMetricsSnapshot();

        res.status(200).json({
            success: true,
            data: {
                historical: {
                    paymentsCommitted: committedCount,
                    paymentsRejected: rejectedCount,
                    repaymentVolumePaise: historicalVolumePaise
                },
                process: {
                    latency: processMetrics.http.latency,
                    throughput: {
                        activeRequests: processMetrics.http.active,
                        totalRequests: processMetrics.http.total
                    },
                    paymentsAttempted: processMetrics.financial.paymentsAttempted,
                    paymentsCommitted: processMetrics.financial.paymentsCommitted
                }
            },
            meta: getMeta('HYBRID_MONGODB_AND_PROCESS', '24h')
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

exports.getLoansOverview = async (req, res) => {
    try {
        const stats = await Loan.aggregate([
            { $match: { status: { $in: ['active', 'pending_approval', 'completed', 'rejected'] } } },
            { 
                $group: { 
                    _id: "$status", 
                    count: { $sum: 1 },
                    totalPayablePaise: { 
                        $sum: { 
                            $cond: [{ $eq: ["$status", "active"] }, "$totalPayablePaise", 0] 
                        } 
                    }
                } 
            }
        ]);

        const distribution = { active: 0, pending_approval: 0, completed: 0, rejected: 0 };
        let activeLoanTotalPayablePaise = 0;

        stats.forEach(s => {
            distribution[s._id] = s.count;
            if (s._id === 'active') {
                activeLoanTotalPayablePaise = s.totalPayablePaise;
            }
        });

        res.status(200).json({
            success: true,
            data: {
                distribution,
                activeLoanTotalPayablePaise
            },
            meta: getMeta('MONGODB', 'ALL_TIME')
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

exports.getLedgerReconciliation = async (req, res) => {
    try {
        const [openIncidents, recentEntries] = await Promise.all([
            ReconciliationIncident.find({ status: { $in: ['OPEN', 'INVESTIGATING'] } }).lean(),
            LedgerEntry.find().sort({ createdAt: -1 }).limit(50).lean()
        ]);

        let ledgerGap = 0;
        openIncidents.forEach(inc => {
            if (typeof inc.expectedValue === 'number' && typeof inc.actualValue === 'number') {
                ledgerGap += Math.abs(inc.expectedValue - inc.actualValue);
            }
        });

        res.status(200).json({
            success: true,
            data: {
                ledgerStatus: openIncidents.length === 0 ? 'BALANCED' : 'UNBALANCED',
                openIncidentCount: openIncidents.length,
                ledgerGap,
                recentEntries
            },
            meta: getMeta('MONGODB', 'ALL_TIME')
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

exports.getIdempotencyMetrics = async (req, res) => {
    try {
        const timeWindow = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h

        const historicalReplays = await SecurityEvent.countDocuments({ 
            eventType: 'IDEMPOTENCY_REPLAY', 
            createdAt: { $gte: timeWindow } 
        });

        const processMetrics = getMetricsSnapshot();

        res.status(200).json({
            success: true,
            data: {
                historicalReplays,
                processReplays: processMetrics.financial.idempotencyReplays
            },
            meta: getMeta('HYBRID_MONGODB_AND_PROCESS', '24h')
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};
