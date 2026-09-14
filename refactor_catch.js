const fs = require('fs');

let loans = fs.readFileSync('controllers/loans.js', 'utf8');

// Replace all instances of `async (req, res) =>` with `async (req, res, next) =>`
loans = loans.replace(/exports\.([a-zA-Z0-9_]+) = async \(req, res\) =>/g, 'exports.$1 = async (req, res, next) =>');

// Helper to replace catch bodies
function replaceCatchBodies(content) {
    let result = '';
    let index = 0;
    while (true) {
        let catchIdx = content.indexOf('catch (err) {', index);
        if (catchIdx === -1) {
            result += content.substring(index);
            break;
        }
        
        // Is it the catch block for `verifyFirebaseOtp`?
        // We only want to replace catch blocks inside exported controller functions.
        // We can check if it's the `verifyFirebaseOtp` function.
        let prevText = content.substring(Math.max(0, catchIdx - 50), catchIdx);
        if (prevText.includes('verifyFirebaseOtp')) {
            // Keep this catch intact, just skip over it
            result += content.substring(index, catchIdx + 'catch (err) {'.length);
            index = catchIdx + 'catch (err) {'.length;
            continue;
        }

        result += content.substring(index, catchIdx + 'catch (err) {'.length);
        
        // Find closing brace of catch block
        let braceCount = 1;
        let i = catchIdx + 'catch (err) {'.length;
        while (i < content.length && braceCount > 0) {
            if (content[i] === '{') braceCount++;
            if (content[i] === '}') braceCount--;
            i++;
        }
        
        result += '\n        next(err);\n    }';
        index = i;
    }
    return result;
}

loans = replaceCatchBodies(loans);
fs.writeFileSync('controllers/loans.js', loans);
console.log('Refactored controllers/loans.js for next(err)');
