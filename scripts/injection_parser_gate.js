const fs = require('fs');
const path = require('path');

const DANGEROUS_PATTERNS = [
    { regex: /\.find\(\s*req\.(body|query|params)\s*\)/, desc: 'Unsanitized object passed to find()' },
    { regex: /\.findOne\(\s*req\.(body|query|params)\s*\)/, desc: 'Unsanitized object passed to findOne()' },
    { regex: /\.findByIdAndUpdate\([^,]+,\s*\{\s*\.\.\.req\.body\s*\}\s*\)/, desc: 'Spread req.body in update' },
    { regex: /\.updateOne\([^,]+,\s*\{\s*\.\.\.req\.body\s*\}\s*\)/, desc: 'Spread req.body in updateOne' },
    { regex: /\.updateMany\([^,]+,\s*\{\s*\.\.\.req\.body\s*\}\s*\)/, desc: 'Spread req.body in updateMany' },
    { regex: /Object\.assign\([^,]+,\s*req\.body\)/, desc: 'Object.assign with req.body' },
    { regex: /\{\s*\.\.\.[^,]+,\s*\.\.\.req\.body\s*\}/, desc: 'Spread req.body onto server object' }
];

function scanDir(dir) {
    let violations = 0;
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory() && !fullPath.includes('node_modules') && !fullPath.includes('.git')) {
            violations += scanDir(fullPath);
        } else if (fullPath.endsWith('.js')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                for (const pattern of DANGEROUS_PATTERNS) {
                    if (pattern.regex.test(line)) {
                        console.log(`🔴 [STATIC INJECTION GATE] ${pattern.desc}`);
                        console.log(`   File : ${fullPath}`);
                        console.log(`   Line : ${i + 1}`);
                        console.log(`   Code : ${line.trim()}\n`);
                        violations++;
                    }
                }
            }
        }
    }
    return violations;
}

const v = scanDir(path.join(__dirname, '..', 'controllers')) + 
          scanDir(path.join(__dirname, '..', 'routes')) + 
          scanDir(path.join(__dirname, '..', 'services'));

console.log('========================================================================');
if (v > 0) {
    console.log(`GATE FAILED — ${v} dangerous injection pattern(s) found.`);
    process.exit(1);
} else {
    console.log('🟢 GATE PASSED — No dangerous mass-assignment or unvalidated query object injection patterns found.');
    process.exit(0);
}
