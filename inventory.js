const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'routes');
const middlewareDir = path.join(__dirname, 'middleware');

console.log("=========================================================================");
console.log("                 PHASE 4E: SECURITY MIDDLEWARE STACK                     ");
console.log("=========================================================================\n");

const middlewares = fs.readdirSync(middlewareDir).filter(f => f.endsWith('.js'));
middlewares.forEach(m => {
    console.log(`- ${m}:`);
    const content = fs.readFileSync(path.join(middlewareDir, m), 'utf8');
    const exportsMatch = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    if (exportsMatch) {
        console.log(`    Exports: ${exportsMatch[1].split(',').map(s => s.trim().replace(/\n/g, '')).join(', ')}`);
    } else {
        console.log(`    Exports: (Dynamic / Default)`);
    }
});

console.log("\n=========================================================================");
console.log("                 PHASE 4E: ENDPOINT INVENTORY                            ");
console.log("=========================================================================\n");

const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));
routeFiles.forEach(file => {
    console.log(`\n### ${file.toUpperCase()} ROUTER ###`);
    const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
    
    // Check for global router middleware
    const globalMw = content.match(/router\.use\(([^)]+)\)/g);
    if (globalMw) {
        console.log(`Global router middleware applied: ${globalMw.join(', ').replace(/router\.use\(/g, '').replace(/\)/g, '')}`);
    }

    const routeLines = content.split('\n').filter(line => line.includes('router.get') || line.includes('router.post') || line.includes('router.put') || line.includes('router.patch') || line.includes('router.delete'));
    
    routeLines.forEach(line => {
        const match = line.match(/router\.(\w+)\(['"]([^'"]+)['"](.*)\)/);
        if (match) {
            const method = match[1].toUpperCase();
            const url = match[2];
            const handlers = match[3].split(',').map(s => s.trim()).filter(s => s.length > 0);
            console.log(`[${method}] ${url} -> ${handlers.join(' -> ')}`);
        }
    });
});
