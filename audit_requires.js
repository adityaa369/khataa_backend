const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        let isDirectory = fs.statSync(dirPath).isDirectory();
        if (isDirectory) {
            if (f !== 'node_modules' && f !== '.git') walkDir(dirPath, callback);
        } else if (f.endsWith('.js')) {
            callback(path.join(dir, f));
        }
    });
}

let brokenImports = 0;

walkDir(__dirname, function(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const requireRegex = /require\(['\`\"](\.[^\'\`\"]+)['\`\"]\)/g;
    let match;
    while ((match = requireRegex.exec(content)) !== null) {
        const importPath = match[1];
        const dirName = path.dirname(filePath);
        let resolvedPath = path.resolve(dirName, importPath);
        
        // Check if file exists (with or without .js)
        if (!fs.existsSync(resolvedPath) && !fs.existsSync(resolvedPath + '.js') && !fs.existsSync(path.join(resolvedPath, 'index.js'))) {
            console.error('BROKEN IMPORT in ' + filePath + ': ' + importPath);
            brokenImports++;
        }
    }
});

if (brokenImports === 0) {
    console.log('ALL LOCAL IMPORTS ARE VALID!');
} else {
    process.exit(1);
}
