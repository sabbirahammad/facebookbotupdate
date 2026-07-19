const isAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'superadmin') {
        next();
    } else {
        res.status(403).json({ message: 'Forbidden: Access is restricted to administrators.' });
    }
};

module.exports = { isAdmin };