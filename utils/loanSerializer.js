const { parseRupeesToPaise, parseRupeesToPaiseOptional } = require('./money');
const FinancialLedgerService = require('../services/FinancialLedgerService');

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

  l.amountPaise = amountPaise;

  if (Array.isArray(l.transactions) && l.transactions.length > 0) {
    FinancialLedgerService.deriveBalances(l);
  }

  const emiAmountPaise = (l.emiAmountPaise != null)
    ? l.emiAmountPaise
    : parseRupeesToPaiseOptional(l.emiAmount);

  const paidAmountPaise = (l.paidAmountPaise != null)
    ? l.paidAmountPaise
    : (parseRupeesToPaiseOptional(l.paidAmount) || 0);

  let principalOutstandingPaise = (l.principalOutstandingPaise != null)
    ? l.principalOutstandingPaise
    : null;

  let interestOutstandingPaise = l.interestOutstandingPaise ?? 0;
  const feesOutstandingPaise = l.feesOutstandingPaise ?? 0;

  let totalPayablePaise = (l.totalPayablePaise != null)
    ? l.totalPayablePaise
    : parseRupeesToPaiseOptional(l.totalPayable);

  // If the credit is pending approval/setup (or has no ledger transactions yet and is not settled),
  // compute the initial principal, interest, and total payable so Review & Details screens show exact numbers.
  const isFinished = ['completed', 'closed', 'rejected', 'cancelled', 'expired'].includes(l.status);
  if ((!Array.isArray(l.transactions) || l.transactions.length === 0) && !isFinished) {
    if (!principalOutstandingPaise || principalOutstandingPaise <= 0) {
      principalOutstandingPaise = Math.max(0, amountPaise - paidAmountPaise);
    }
    const loanTypeStr = String(l.loanType || l.type || '').toLowerCase();
    const ratePct = Number(l.interestRate || 0);
    if ((loanTypeStr.includes('interest') || loanTypeStr.includes('home')) && ratePct > 0 && interestOutstandingPaise <= 0) {
      const isDays = String(l.durationType || '').toLowerCase() === 'days';
      const rawDuration = Number(l.durationMonths || 0);
      const effectiveMonths = isDays ? (rawDuration / 30.0) : rawDuration;
      interestOutstandingPaise = Math.floor((amountPaise * ratePct * effectiveMonths) / 100);
    }
    if (!totalPayablePaise || totalPayablePaise <= 0) {
      totalPayablePaise = principalOutstandingPaise + interestOutstandingPaise + feesOutstandingPaise;
    }
  }

  return {
    ...l,
    id: (l._id || l.id || '').toString(),
    amountPaise,
    emiAmountPaise,
    totalPayablePaise: totalPayablePaise ?? ( (principalOutstandingPaise || 0) + interestOutstandingPaise + feesOutstandingPaise ),
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
