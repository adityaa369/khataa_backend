const fs = require('fs');
let content = fs.readFileSync('models/Loan.js', 'utf8');

content = content.replace(/totalPayable:\s*\{\s*type:\s*Number,\s*default:\s*0\s*\}/, 'totalPayable: { type: Number }');
content = content.replace(/totalPayablePaise:\s*\{\s*type:\s*Number,\s*validate:\s*\{\s*validator:\s*Number\.isInteger\s*\},\s*default:\s*0\s*\}/, 'totalPayablePaise: { type: Number, validate: { validator: Number.isInteger } }');
content = content.replace(/paidAmount:\s*\{\s*type:\s*Number,\s*default:\s*0\s*\}/, 'paidAmount: { type: Number }');
content = content.replace(/paidAmountPaise:\s*\{\s*type:\s*Number,\s*validate:\s*\{\s*validator:\s*Number\.isInteger\s*\},\s*default:\s*0\s*\}/, 'paidAmountPaise: { type: Number, validate: { validator: Number.isInteger } }');

content = content.replace("    transactions: [", "    transactions: { type: [");
content = content.replace("            recordedBy: String\n        }\n    ],", "            recordedBy: String\n        }\n    ], default: undefined },");

content = content.replace("    custom_transactions: [", "    custom_transactions: { type: [");
content = content.replace("            recordedBy: String\n        }\n    ]", "            recordedBy: String\n        }\n    ], default: undefined }");

fs.writeFileSync('models/Loan.js', content);
console.log('Defaults removed correctly.');
