const { parseRupeesToPaise, parseRupeesToPaiseOptional, DataIntegrityError } = require('../../utils/money');
const { loanSerializer } = require('../../utils/loanSerializer');
const assert = require('assert');

// Test strict parser
const strictCases = [
  { input: "5000abc", err: true },
  { input: "1e3", err: true },
  { input: "12.345", err: true },
  { input: null, err: true },
  { input: undefined, err: true },
  { input: "", err: true },
  { input: "NaN", err: true },
  { input: "Infinity", err: true },
  { input: "0", expected: 0 },
  { input: "0.00", expected: 0 },
  { input: 5000, expected: 500000 },
  { input: "5000", expected: 500000 },
  { input: "5000.50", expected: 500050 },
  { input: "89765432.50", expected: 8976543250 },
  { input: "0.1", expected: 10 },
  { input: "0.01", expected: 1 },
  { input: -500, expected: -50000 },
];

for (const tc of strictCases) {
  try {
    const res = parseRupeesToPaise(tc.input);
    if (tc.err) {
      console.error(`Expected error for strict input: ${tc.input}, got: ${res}`);
      process.exit(1);
    }
    if (res !== tc.expected) {
      console.error(`Mismatch for strict input: ${tc.input}. Expected ${tc.expected}, got ${res}`);
      process.exit(1);
    }
  } catch (err) {
    if (!tc.err) {
      console.error(`Unexpected error for strict input: ${tc.input}. Error: ${err.message}`);
      process.exit(1);
    }
    if (err.name !== 'DataIntegrityError') {
      console.error(`Expected DataIntegrityError for strict input: ${tc.input}, got: ${err.name}`);
      process.exit(1);
    }
  }
}

// Test optional parser
const optionalCases = [
  { input: null, expected: 0 },
  { input: undefined, expected: 0 },
  { input: "", expected: 0 },
  { input: "abc", err: true },
  { input: "5000", expected: 500000 },
];

for (const tc of optionalCases) {
  try {
    const res = parseRupeesToPaiseOptional(tc.input);
    if (tc.err) {
      console.error(`Expected error for optional input: ${tc.input}, got: ${res}`);
      process.exit(1);
    }
    if (res !== tc.expected) {
      console.error(`Mismatch for optional input: ${tc.input}. Expected ${tc.expected}, got ${res}`);
      process.exit(1);
    }
  } catch (err) {
    if (!tc.err) {
      console.error(`Unexpected error for optional input: ${tc.input}. Error: ${err.message}`);
      process.exit(1);
    }
  }
}

// Test loanSerializer
const mockLoan = {
  amount: 5000,
  totalPayable: 5000,
  paidAmount: 500,
  transactions: [
    { amount: 100 }
  ]
};

const serialized = loanSerializer(mockLoan);
assert.strictEqual(serialized.amountPaise, 500000);
assert.strictEqual(serialized.paidAmountPaise, 50000);
assert.strictEqual(serialized.principalOutstandingPaise, null);
assert.strictEqual(serialized.interestOutstandingPaise, null);
assert.strictEqual(serialized.feesOutstandingPaise, null);
assert.strictEqual(serialized.transactions[0].amountPaise, 10000);

console.log('✅ Unit tests for money & loanSerializer passed.');
process.exit(0);
