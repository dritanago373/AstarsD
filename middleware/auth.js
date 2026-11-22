// middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ success: false, message: 'No token, authorization denied' });
    }

    // Must match the secret used to sign tokens in server.js
    const secret = process.env.JWT_SECRET || 'secret';
    const decoded = jwt.verify(token, secret);

    // Look up by id (not email) so tokens stay valid after an email change.
    // Tokens issued before this change also contain the id, so nobody is logged out.
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    req.user = user; // full Mongoose document (billing routes call user.save())
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired' });
    }
    if (process.env.NODE_ENV !== 'production') console.error('Auth error:', error.message);
    res.status(401).json({ success: false, message: 'Token is not valid' });
  }
};

module.exports = auth;