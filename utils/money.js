class DataIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataIntegrityError';
    this.code = 'DATA_INTEGRITY';
  }
}

/**
 * parseRupeesToPaise — strict financial parser.
 *
 * Rules:
 *   Pure string arithmetic. No parseFloat, Math.round, .toFixed.
 *   Only parseInt on isolated whole/fractional string components.
 *
 *   null / undefined / ''    → DataIntegrityError  (mandatory financial fields)
 *   malformed string         → DataIntegrityError
 *   "5000abc"                → DataIntegrityError
 *   "1e3"                    → DataIntegrityError
 *   "12.345"                 → DataIntegrityError
 *   "-500"                   → -50000
 *   "89765432.50"            → 8976543250
 *   "0.10"                   → 10
 *   "0.01"                   → 1
 *
 * ONLY call this for mandatory financial fields that must exist.
 */
function parseRupeesToPaise(value) {
  if (value == null || value === '') {
    throw new DataIntegrityError(`Required financial value is absent: ${JSON.stringify(value)}`);
  }
  const str = String(value).trim();
  if (str === '' || str === 'NaN' || str === 'Infinity' || str === '-Infinity') {
    throw new DataIntegrityError(`Invalid financial representation: "${str}"`);
  }

  const negative = str.startsWith('-');
  const abs = negative ? str.slice(1) : str;

  if (/[eE]/.test(abs)) {
    throw new DataIntegrityError(`Scientific notation not allowed in financial value: "${str}"`);
  }

  const dotIdx = abs.indexOf('.');
  let wholeStr, fracStr;

  if (dotIdx === -1) {
    wholeStr = abs;
    fracStr = '00';
  } else {
    wholeStr = abs.slice(0, dotIdx);
    fracStr = abs.slice(dotIdx + 1);
    if (fracStr.length > 2) {
      throw new DataIntegrityError(`More than 2 decimal places in financial value: "${str}"`);
    }
    fracStr = fracStr.padEnd(2, '0');
  }

  if (!/^\d*$/.test(wholeStr) || !/^\d{2}$/.test(fracStr)) {
    throw new DataIntegrityError(`Non-numeric characters in financial value: "${str}"`);
  }

  const wholeNum = wholeStr === '' ? 0 : parseInt(wholeStr, 10);
  const fracNum = parseInt(fracStr, 10);
  const result = wholeNum * 100 + fracNum;

  return negative ? -result : result;
}

/**
 * parseRupeesToPaiseOptional — for fields that may be genuinely absent.
 *
 * null / undefined / '' → 0  (field is legitimately not present)
 * malformed             → DataIntegrityError  (malformed ≠ absent)
 */
function parseRupeesToPaiseOptional(value) {
  if (value == null || value === '') return 0;
  return parseRupeesToPaise(value);
}

module.exports = { parseRupeesToPaise, parseRupeesToPaiseOptional, DataIntegrityError };
