const fs = require('fs');
let code = fs.readFileSync('controllers/loans.js', 'utf8');

const replacement = `        for (const chit of ownedChits) {
            loansMapped.push({
                _id: chit._id,
                loanType: 'chitfund',
                amount: chit.totalValue, 
                amountPaise: require('../utils/money').parseRupeesToPaise(chit.totalValue.toString()),
                interestRate: 0,
                durationMonths: chit.totalMonths,
                status: chit.status === 'completed' ? 'completed' : 'active',
                progress: (chit.completedMonths || 0) / (chit.totalMonths || 1),
                startDate: chit.startDate || chit.createdAt,
                endDate: null,
                lenderName: \`\${req.user.firstName || ''} \${req.user.lastName || ''}\`,
                borrowerName: \`\${chit.currentSubscribersCount} Member(s)\`,
                borrowerPhone: 'N/A',
                emiAmount: chit.monthlySubscription, 
                emiAmountPaise: require('../utils/money').parseRupeesToPaise(chit.monthlySubscription.toString()),
                principalOutstandingPaise: require('../utils/money').parseRupeesToPaise(chit.totalValue.toString()),
                interestOutstandingPaise: 0,
                feesOutstandingPaise: 0,
                createdAt: chit.createdAt
            });
        }
        
        loansMapped.sort((a, b) => {`;

code = code.replace(/const ownedChits = await ChitFund\.find\(\{ owner: req\.user\.id \}\);[\s\S]*?const aDate = new Date\(a\.createdAt \|\| a\.startDate \|\| 0\);/, 'const ownedChits = await ChitFund.find({ owner: req.user.id });\n' + replacement + '\n            const aDate = new Date(a.createdAt || a.startDate || 0);');

fs.writeFileSync('controllers/loans.js', code);
