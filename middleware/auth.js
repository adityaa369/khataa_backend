const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ success: false, message: 'Not authorized to access this route' });
    }

    try {
        let decoded;
        try {
            // Attempt with primary (new) secret
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            // Attempt with secondary (old) secret during migration windows
            if (process.env.JWT_SECRET_PREVIOUS) {
                decoded = jwt.verify(token, process.env.JWT_SECRET_PREVIOUS);
            } else {
                throw err;
            }
        }

        req.user = await User.findOne({ id: decoded.id }).select('-__v');

        if (!req.user) {
            return res.status(401).json({ success: false, message: 'User account not found' });
        }

        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(419).json({ success: false, message: 'Session expired, please login again', code: 'TOKEN_EXPIRED' });
        }
        return res.status(401).json({ success: false, message: 'Not authorized to access this route' });
    }
};

module.exports = { protect };

