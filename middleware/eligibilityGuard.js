const requireEmailVerified = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!req.user.email || !req.user.isEmailVerified) {
        return res.status(403).json({ 
            success: false, 
            code: 'EMAIL_VERIFICATION_REQUIRED', 
            message: 'Email verification is required to perform this action.' 
        });
    }
    next();
};

const requireKycComplete = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!req.user.isVerified) {
        return res.status(403).json({ 
            success: false, 
            code: 'KYC_REQUIRED', 
            message: 'KYC verification is required to perform this action.' 
        });
    }
    next();
};

const requireFinancialEligibility = [requireEmailVerified, requireKycComplete];

module.exports = {
    requireEmailVerified,
    requireKycComplete,
    requireFinancialEligibility
};
