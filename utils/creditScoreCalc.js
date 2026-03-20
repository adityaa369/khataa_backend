const CreditScore = require('../models/CreditScore');
const Loan = require('../models/Loan');

async function updateCreditScore(userId) {
    const loans = await Loan.find({ borrower: userId, status: { $in: ['active', 'completed', 'overdue', 'defaulted'] } });

    if (loans.length === 0) return;

    let scorePoints = 0;
    let totalLoanAmount = 0;
    const now = new Date();

    loans.forEach(loan => {
        const weight = Math.log10(loan.amount + 10); // Higher amount loans have slightly higher impact
        totalLoanAmount += loan.amount;

        if (loan.status === 'completed') {
            scorePoints += (100 * weight); // Full points for completion

            // Bonus for completing before end date
            if (loan.endDate && loan.updatedAt && new Date(loan.updatedAt) < loan.endDate) {
                scorePoints += (10 * weight);
            }
        } else if (loan.status === 'active') {
            scorePoints += (loan.progress * 50 * weight); // Partial points based on progress

            // Penalize or reward based on real-time due dates
            if (loan.nextDueDate) {
                const daysUntilDue = (loan.nextDueDate - now) / (1000 * 60 * 60 * 24);

                if (daysUntilDue < 0) {
                    // Late payment penalty (max 30 points)
                    const daysLate = Math.abs(daysUntilDue);
                    scorePoints -= (Math.min(daysLate, 30) * 1 * weight);
                } else if (daysUntilDue > 15 && loan.progress > 0) {
                    // Making progress early gives small bonus
                    scorePoints += (5 * weight);
                }
            }
        } else if (loan.status === 'overdue') {
            scorePoints -= (30 * weight); // Penalty for being overdue
        } else if (loan.status === 'defaulted') {
            scorePoints -= (100 * weight); // Heavy penalty for default
        }
    });

    // 2. Credit Utilization Factor (30%)
    const completedLoansCount = loans.filter(l => l.status === 'completed').length;
    const capacity = 50000 + (completedLoansCount * 25000); // Dynamic capacity
    const utilizationRaw = totalLoanAmount / capacity;
    const boundedUtilization = Math.min(utilizationRaw, 1.0);
    const utilizationScore = 300 * (1 - boundedUtilization); // max 300 points out of 900 scale influence

    // 3. Length of Credit History / Duration Factor (15%)
    let monthsOfHistory = 0;
    loans.forEach(loan => {
        if (loan.durationMonths) monthsOfHistory += loan.durationMonths;
    });
    const historyScore = Math.min(monthsOfHistory * 5, 150); // max 150 points

    const averageWeight = totalLoanAmount > 0 ? (scorePoints / Math.log10(totalLoanAmount + 10)) : 0;
    let calculatedScore = 300 + Math.floor(averageWeight) + utilizationScore + historyScore;
    calculatedScore = Math.max(300, Math.min(calculatedScore, 900)); // Cap at 900

    const newScore = Math.floor(calculatedScore);

    let status = 'Good';
    if (newScore < 550) status = 'Poor';
    else if (newScore < 650) status = 'Fair';
    else if (newScore < 750) status = 'Good';
    else status = 'Excellent';

    await CreditScore.findOneAndUpdate(
        { user: userId },
        {
            cibilScore: newScore,
            experianScore: newScore + 5,
            status,
            lastUpdated: Date.now()
        },
        { upsert: true }
    );
}

exports.updateCreditScore = updateCreditScore;
