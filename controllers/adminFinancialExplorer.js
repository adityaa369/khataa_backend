const Loan = require('../models/Loan');
const SecurityEvent = require('../models/SecurityEvent');
const ReconciliationIncident = require('../models/ReconciliationIncident');
const LedgerEntry = require('../models/LedgerEntry');
const Transaction = require('../models/Transaction');
const { getMetricsSnapshot } = require('../middleware/metrics');

const getMeta = (source, window = '24h') => ({
    lastVerifiedAt: new Date().toISOString(),
    source,
    window
});

exports.getPaymentsOverview = async (req, res) => {
    try {
        const timeWindow = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h

        const [committedEvents, rejectedEvents, txAgg, ledgerAgg] = await Promise.all([
            SecurityEvent.countDocuments({ eventType: 'LOAN_PAYMENT_COMMITTED', createdAt: { $gte: timeWindow } }),
            SecurityEvent.countDocuments({ eventType: 'OVERPAYMENT_ATTEMPT', createdAt: { $gte: timeWindow } }),
            Transaction.aggregate([
                {
                    $match: {
                        type: { $in: ['PAYMENT'] },
                        createdAt: { $gte: timeWindow }
                    }
                },
                { $group: { _id: null, volume: { $sum: '$amountPaise' }, count: { $sum: 1 } } }
            ]),
            LedgerEntry.aggregate([
                {
                    $match: {
                        type: 'CREDIT',
                        createdAt: { $gte: timeWindow }
                    }
                },
                { $group: { _id: null, volume: { $sum: '$amountPaise' }, count: { $sum: 1 } } }
            ])
        ]);

        const historicalVolumePaise = txAgg[0]?.volume || ledgerAgg[0]?.volume || 0;
        const committedCount = Math.max(committedEvents, txAgg[0]?.count || 0, ledgerAgg[0]?.count || 0);
        const processMetrics = getMetricsSnapshot();

        res.status(200).json({
            success: true,
            data: {
                historical: {
                    paymentsCommitted: committedCount,
                    paymentsRejected: rejectedEvents,
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
        const allLoans = await Loan.find({
            status: { $in: ['active', 'pending_approval', 'completed', 'rejected'] }
        }).select('status amount amountPaise totalPayable totalPayablePaise paidAmount paidAmountPaise principalOutstandingPaise interestOutstandingPaise').lean();

        const distribution = { active: 0, pending_approval: 0, completed: 0, rejected: 0 };
        let activeLoanTotalPayablePaise = 0;

        allLoans.forEach(l => {
            if (distribution[l.status] !== undefined) {
                distribution[l.status]++;
            }
            if (l.status === 'active') {
                if (typeof l.principalOutstandingPaise === 'number') {
                    activeLoanTotalPayablePaise += Math.max(0, l.principalOutstandingPaise + (l.interestOutstandingPaise || 0));
                } else if (typeof l.totalPayablePaise === 'number') {
                    activeLoanTotalPayablePaise += Math.max(0, l.totalPayablePaise - (l.paidAmountPaise || 0));
                } else {
                    const totalR = l.totalPayable || l.amount || 0;
                    const paidR = l.paidAmount || 0;
                    activeLoanTotalPayablePaise += Math.max(0, Math.round((totalR - paidR) * 100));
                }
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
        const timeWindow = new Date(Date.now() - 24 * 60 * 60 * 1000);

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
