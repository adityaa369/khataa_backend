const fs = require('fs');

const lines = fs.readFileSync('C:/Users/adity/.gemini/antigravity/brain/1b6abb30-05a9-4fb8-8af8-93c7629b5bdd/.system_generated/logs/transcript_full.jsonl', 'utf8').split('\n');

for (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    
    // Look for tool_calls or tool outputs containing Loan.js content
    if (entry.content && entry.content.includes('V2 ACCOUNTING (MATERIALIZED CACHE)')) {
        console.log('--- MATCH FOUND IN CONTENT ---');
        const snippet = entry.content.substring(entry.content.indexOf('V2 ACCOUNTING'), entry.content.indexOf('V2 ACCOUNTING') + 1000);
        console.log(snippet);
        console.log('------------------------------');
    }
}
