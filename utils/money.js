exports.parseRupeesToPaise = (rupees) => {
    if (rupees === undefined || rupees === null) return 0;
    const str = String(rupees).trim();
    if (str === '') return 0;
    if (str.includes('e') || str.includes('E')) return 0; // reject scientific
    if (str === 'NaN' || str === 'Infinity' || str === '-Infinity') return 0;
    
    let sign = 1;
    let s = str;
    if (s.startsWith('-')) {
        sign = -1;
        s = s.substring(1);
    }
    
    const parts = s.split('.');
    if (parts.length > 2) return 0; // invalid format
    
    let r = parseInt(parts[0] || '0', 10);
    if (isNaN(r)) return 0;
    
    let p = 0;
    if (parts.length === 2) {
        let decimalPart = parts[1].substring(0, 2);
        if (decimalPart.length === 1) decimalPart += '0';
        p = parseInt(decimalPart, 10);
        if (isNaN(p)) p = 0;
    }
    
    return sign * ((r * 100) + p);
};

exports.formatPaiseToString = (paise) => {
    if (paise === undefined || paise === null || isNaN(paise)) return '0.00';
    const p = Math.abs(Math.floor(Number(paise)));
    const sign = paise < 0 ? '-' : '';
    const r = Math.floor(p / 100);
    const cents = String(p % 100).padStart(2, '0');
    return sign + r + '.' + cents;
};
