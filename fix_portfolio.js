const fs = require('fs');
let c1 = fs.readFileSync('controllers/loans.js', 'utf8');
if (!c1.includes('exports.getPortfolioSummary = async (req, res) => {')) {
    c1 = c1.replace(/const summary = await require\('\.\.\/models\/Loan'\)\.aggregate\(\[/, 'exports.getPortfolioSummary = async (req, res) => {\n    try {\n        const lenderId = req.user.id;\n        const summary = await require(\'../models/Loan\').aggregate([');
}
fs.writeFileSync('controllers/loans.js', c1);
