const { parseRupeesToPaise, parseRupeesToPaiseOptional } = require('./money');

function serializeTransaction(t) {
  const tObj = t.toObject ? t.toObject() : { ...t };
  const amountPaise = (tObj.amountPaise != null)
    ? tObj.amountPaise
    : parseRupeesToPaise(tObj.amount); // strict — transaction amount must exist
    
  return { ...tObj, amountPaise };
}

function loanSerializer(loanDoc) {
  const l = loanDoc.toObject ? loanDoc.toObject() : { ...loanDoc };

  const amountPaise = (l.amountPaise != null)
    ? l.amountPaise
    : parseRupeesToPaise(l.amount);

  const emiAmountPaise = (l.emiAmountPaise != null)
    ? l.emiAmountPaise
    : parseRupeesToPaiseOptional(l.emiAmount);

  const totalPayablePaise = (l.totalPayablePaise != null)
    ? l.totalPayablePaise
    : parseRupeesToPaiseOptional(l.totalPayable);

  const paidAmountPaise = (l.paidAmountPaise != null)
    ? l.paidAmountPaise
    : parseRupeesToPaiseOptional(l.paidAmount);

  // principalOutstanding: use V2 ledger field if present; otherwise null if unknown.
  // Never fabricate principal allocation from totalPayable - paidAmount.
  const principalOutstandingPaise = (l.principalOutstandingPaise != null)
    ? l.principalOutstandingPaise
    : null;

  const interestOutstandingPaise = l.interestOutstandingPaise ?? null;
  const feesOutstandingPaise = l.feesOutstandingPaise ?? null;

  return {
    ...l,
    amountPaise,
    emiAmountPaise,
    totalPayablePaise,
    paidAmountPaise,
    principalOutstandingPaise,
    interestOutstandingPaise,
    feesOutstandingPaise,
    financialStatus: l.status,
    transactions: (l.transactions || []).map(serializeTransaction),
  };
}

function chitFundSerializer(chitDoc, extras = {}) {
  const c = chitDoc.toObject ? chitDoc.toObject() : { ...chitDoc };
  return {
    ...c,
    _id: c._id,
    loanType: 'chitfund',
    amountPaise: parseRupeesToPaiseOptional(c.totalValue),
    principalOutstandingPaise: 0,
    interestOutstandingPaise: null,
    feesOutstandingPaise: null,
    emiAmountPaise: parseRupeesToPaiseOptional(c.monthlySubscription),
    totalPayablePaise: parseRupeesToPaiseOptional(c.totalValue),
    paidAmountPaise: 0,
    financialStatus: c.status,
    transactions: [],
    ...extras,
  };
}

module.exports = { loanSerializer, chitFundSerializer, serializeTransaction };
