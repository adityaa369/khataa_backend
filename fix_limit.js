const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');
code = code.replace(/app\.use\(bodyParser\.json\(\{\s*limit:\s*'100kb'\s*\}\)\);/, 
`app.use((req, res, next) => {
    if (req.path === '/api/loans/upload-document') {
        bodyParser.json({ limit: '10mb' })(req, res, next);
    } else {
        bodyParser.json({ limit: '100kb' })(req, res, next);
    }
});`);
code = code.replace(/app\.use\(bodyParser\.urlencoded\(\{\s*limit:\s*'100kb',\s*extended:\s*true\s*\}\)\);/, 
`app.use((req, res, next) => {
    if (req.path === '/api/loans/upload-document') {
        bodyParser.urlencoded({ limit: '10mb', extended: true })(req, res, next);
    } else {
        bodyParser.urlencoded({ limit: '100kb', extended: true })(req, res, next);
    }
});`);
fs.writeFileSync('index.js', code);
