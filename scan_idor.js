const fs = require('fs');
const path = require('path');

const dirs = ['controllers', 'sockets'];

dirs.forEach(dir => {
    fs.readdirSync(dir).forEach(file => {
        if (!file.endsWith('.js')) return;
        const filepath = path.join(dir, file);
        const content = fs.readFileSync(filepath, 'utf8');
        
        console.log(`\n--- ${filepath} ---`);
        
        // Match route handlers: exports.something = async (req, res)
        const regex = /exports\.(\w+)\s*=\s*(?:async\s*)?\(\s*req\s*,\s*res/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const funcName = match[1];
            
            // Extract a chunk of code after the function starts to look for IDOR checks
            const startIdx = match.index;
            const chunk = content.substring(startIdx, startIdx + 800);
            
            const hasReqUserId = chunk.includes('req.user.id');
            const hasReqUserPhone = chunk.includes('req.user.phone');
            const isSelfOrOwner = chunk.includes('req.user.id') && (chunk.includes('owner') || chunk.includes('lender') || chunk.includes('borrower') || chunk.includes('userId'));
            
            console.log(`Method: ${funcName}`);
            console.log(`   - Checks req.user.id? ${hasReqUserId}`);
            if (hasReqUserId && !isSelfOrOwner) {
                console.log(`   [!] Warning: Uses req.user.id but no obvious ownership word (owner/lender/borrower) found in first 800 chars.`);
            }
        }
    });
});
