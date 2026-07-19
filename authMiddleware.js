const jwt =require('jsonwebtoken');
const User = require('./User');

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      // হেডার থেকে টোকেন নিন (Bearer <token>)
      token = req.headers.authorization.split(' ')[1];

      // টোকেনটি ভেরিফাই করুন
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // টোকেন থেকে পাওয়া আইডি দিয়ে ব্যবহারকারীকে খুঁজুন এবং req অবজেক্টে যুক্ত করুন
      req.user = await User.findById(decoded.id).select('-accessToken');

      if (!req.user) {
        return res.status(401).json({ message: 'Not authorized, user not found' });
      }

      next(); // পরবর্তী মিডলওয়্যার বা রাউটে যান
    } catch (error) {
      console.error('Token verification failed:', error);
      res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    res.status(401).json({ message: 'Not authorized, no token' });
  }
};

const superAdminOnly = (req, res, next) => {
    if (req.user && req.user.role === 'superadmin') {
        next();
    } else {
        res.status(403).json({ message: 'Access denied, Superadmin only' });
    }
};

module.exports = { protect, superAdminOnly };