const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');

c = c.replace(/app\.use\(\(err, req, res, next\) => \{[\s\S]*?\}\);/, `const errorHandler = require('./middleware/errorHandler');
app.use(errorHandler);`);

fs.writeFileSync('index.js', c);
console.log('Replaced error handler in index.js');
