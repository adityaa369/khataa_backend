const CreditScore = require('../models/CreditScore');
const Loan = require('../models/Loan');
const { updateCreditScore } = require('../utils/creditScoreCalc');

// @desc    Get user credit score (with lazy update)
// @route   GET /api/credit-score
// @access  Private
exports.getCreditScore = async (req, res) => {
    try {
        await checkOverdueLoans(req.user.id);
        await updateCreditScore(req.user.id);
        const score = await CreditScore.findOne({ user: req.user.id });
        res.status(200).json({ success: true, score });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// @desc    Get Credit Insights
// @route   GET /api/credit-score/insights
// @access  Private
exports.getInsights = async (req, res) => {
    try {
        const userId = req.user.id;
        const loans = await Loan.find({ borrower: userId });

        // Calculate Age (Oldest Loan)
        let oldestDate = new Date();
        if (loans.length > 0) {
            oldestDate = loans.reduce((oldest, loan) => {
                return loan.createdAt < oldest ? loan.createdAt : oldest;
            }, new Date());
        }

        const now = new Date();
        const diffTime = Math.abs(now - oldestDate);
        const diffYears = (diffTime / (1000 * 60 * 60 * 24 * 365)).toFixed(1);

        // Calculate Limit & Utilization
        let totalLimit = 0; // Total approved amount
        let currentDebt = 0;

        loans.forEach(loan => {
            if (loan.status === 'active' || loan.status === 'completed') {
                totalLimit += loan.amount;
                if (loan.status === 'active') {
                    currentDebt += (loan.amount * (1 - (loan.progress || 0)));
                }
            }
        });

        const utilization = totalLimit > 0 ? ((currentDebt / totalLimit) * 100).toFixed(0) : 0;
        const onTimePayments = loans.filter(l => l.status === 'completed').length; // Simplification

        res.status(200).json({
            success: true,
            insights: {
                creditAge: `${diffYears} Years`,
                totalLimit: totalLimit,
                utilization: `${utilization}%`,
                onTimePayments: `${onTimePayments}/${loans.length}`,
                msg: 'Healthy' // Dynamic logic can be added
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// Helper: Check for overdue loans and degrade score
async function checkOverdueLoans(userId) {
    const loans = await Loan.find({
        borrower: userId,
        status: 'active'
    });

    let penalty = 0;
    const now = new Date();

    loans.forEach(loan => {
        // Calculate Expected End Date
        const startDate = new Date(loan.startDate || loan.createdAt);
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + loan.durationMonths);

        if (now > endDate && loan.progress < 1.0) {
            // Overdue!
            penalty += 50; // Heavy penalty for overdue
        }
    });

    if (penalty > 0) {
        await CreditScore.findOneAndUpdate(
            { user: userId },
            { $inc: { cibilScore: -penalty, experianScore: -penalty } }
        );
    }
}
