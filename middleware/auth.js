const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    console.log("👉 1. Auth Header received:", authHeader ? "YES" : "NO");
    
    const token = authHeader?.replace('Bearer ', '');
    
    if (!token) {
      console.log("❌ 2. No token found. Returning 401.");
      return res.status(401).json({
        success: false,
        message: 'No token, authorization denied'
      });
    }

    console.log("👉 3. Token extracted. Verifying...");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("👉 4. Token valid. Decoded Email:", decoded.email);
    
    console.log("👉 5. Searching for user in DB by email...");
    // 👇 THIS IS THE LINE WE CHANGED 👇
    const user = await User.findOne({ email: decoded.email }).select('-password');
    
    if (!user) {
      console.log("❌ 6. User NOT found in database. Returning 401.");
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }
    
    console.log("✅ 7. User found! Proceeding to route...");
    req.user = user;
    next();
    
  } catch (error) {
    console.error("🚨 8. AUTH CRASHED:", error.message);
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired' });
    }
    res.status(401).json({ success: false, message: 'Token is not valid' });
  }
};

module.exports = auth;