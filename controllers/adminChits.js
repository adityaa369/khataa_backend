const ChitFund = require('../models/ChitFund');
const ChitSubscription = require('../models/ChitSubscription');
const ChitLedger = require('../models/ChitLedger');
const ChitBid = require('../models/ChitBid');
const ReconciliationIncident = require('../models/ReconciliationIncident');

exports.getChitOverview = async (req, res) => {
    const activeChits = await ChitFund.countDocuments({ status: { $in: ['active', 'open'] } });
    const activeMembers = await ChitSubscription.countDocuments({ status: 'active' });
    const liveAuctions = 14; // Mocked for real-time aggregation since sockets manage state in real app
    
    // Aggregations for settlements and dividends
    const ledgerStats = await ChitLedger.aggregate([
        { $match: { status: 'settled', createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } } },
        { $group: { 
            _id: null, 
            settlements: { $sum: 1 },
            totalDividends: { $sum: { $multiply: ["$dividendPerHead", 20] } }, // Rough calc
            totalCommissions: { $sum: "$commissionAmount" }
        }}
    ]);

    const incidents = await ReconciliationIncident.countDocuments({ entityType: 'ChitLedger', status: 'OPEN' });

    res.status(200).json({
        success: true,
        data: {
            activeChits,
            activeMembers,
            liveAuctions,
            settlementsToday: ledgerStats[0]?.settlements || 0,
            dividendsDistributedPaise: ledgerStats[0]?.totalDividends || 0,
            commissionsPaise: ledgerStats[0]?.totalCommissions || 0,
            incidents
        }
    });
};

exports.getChits = async (req, res) => {
    const chits = await ChitFund.find().sort({ createdAt: -1 }).limit(100);
    res.status(200).json({ success: true, data: chits });
};

exports.getChitDetail = async (req, res) => {
    const chit = await ChitFund.findById(req.params.id);
    if (!chit) return res.status(404).json({ success: false, message: 'Chit not found' });
    
    const subscriptions = await ChitSubscription.find({ chitFund: chit._id }).populate('user', 'firstName lastName');
    const ledgers = await ChitLedger.find({ groupId: chit._id }).sort({ cycleIndex: -1 });
    
    res.status(200).json({
        success: true,
        data: {
            chit,
            subscriptions,
            ledgers,
            timeline: [
                { time: chit.createdAt, event: 'Chit Created', status: 'SUCCESS' }
            ]
        }
    });
};
