const normalizeLoanRecord = (loanObj) => {
    // 1. Strict parser: Ensure amountPaise exists as an integer.
    if (loanObj.amountPaise != null && Number.isInteger(loanObj.amountPaise)) {
        // V2 record -> unchanged
    } else if (loanObj.amount != null) {
        // Legacy record -> compute amountPaise
        loanObj.amountPaise = Math.round(loanObj.amount * 100);
    } else {
        throw new Error(`Invalid loan record ${loanObj._id}: Missing both amount and amountPaise`);
    }

    // Do the same for paidAmountPaise vs paidAmount if necessary, 
    // but the error specifically was amountPaise. Let's be thorough:
    if (loanObj.paidAmountPaise == null && loanObj.paidAmount != null) {
        loanObj.paidAmountPaise = Math.round(loanObj.paidAmount * 100);
    }
    if (loanObj.totalPayablePaise == null && loanObj.totalPayable != null) {
        loanObj.totalPayablePaise = Math.round(loanObj.totalPayable * 100);
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
