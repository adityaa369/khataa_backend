const normalizeLoanRecord = (loanObj) => {
    // 1. Strict parser: Ensure amountPaise exists as an integer.
    if (loanObj.amountPaise != null && Number.isInteger(loanObj.amountPaise)) {
        // V2 record -> unchanged
    } else if (loanObj.amount != null) {
        // Legacy record -> compute amountPaise using safe string parser
        loanObj.amountPaise = require('../utils/money').parseRupeesToPaise(loanObj.amount.toString());
    } else {
        throw new Error(`Invalid loan record ${loanObj._id}: Missing both amount and amountPaise`);
    }

    // Do the same for paidAmountPaise vs paidAmount if necessary, 
    // but the error specifically was amountPaise. Let's be thorough:
    if (loanObj.paidAmountPaise == null && loanObj.paidAmount != null) {
        loanObj.paidAmountPaise = require('../utils/money').parseRupeesToPaise(loanObj.paidAmount.toString());
    }
    if (loanObj.totalPayablePaise == null && loanObj.totalPayable != null) {
        loanObj.totalPayablePaise = require('../utils/money').parseRupeesToPaise(loanObj.totalPayable.toString());
    }
    
    return loanObj;
};

const serializeLoan = (loan) => {
    const loanObj = loan.toObject ? loan.toObject() : { ...loan };
    return normalizeLoanRecord(loanObj);
};

module.exports = {
    normalizeLoanRecord,
    serializeLoan
};
