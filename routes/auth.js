const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendVerificationEmail } = require('../services/emailService');

// ============================================
// REGISTER – returns token & user directly
// ============================================
router.post('/register', async (req, res) => {
  const { email, password, businessName, plan } = req.body;

  try {
    // Check if email exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate verification code (optional, but we'll still send)
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Create user – set isVerified = true to avoid verification step
    const user = new User({
      email,
      password: hashedPassword,
      businessName,
      plan: plan || 'single',
      isVerified: true, // auto-verify for simplicity (or keep false and frontend handles verify)
      verificationCode: code,
      verificationCodeExpires: Date.now() + 300000,
      trialEnds: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      isSubscribed: false,
      repliesUsed: 0,
      subscriptionDaysLeft: 0,
    });

    await user.save();

    // Send verification email (optional – user can verify later)
    await sendVerificationEmail(email, code, businessName);

    // Generate JWT
    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Account created! 14-day free trial started.',
      token,
      user: {
        id: user._id,
        email: user.email,
        businessName: user.businessName,
        plan: user.plan,
        isVerified: user.isVerified,
        trialEnds: user.trialEnds,
        isSubscribed: user.isSubscribed,
        subscriptionDaysLeft: user.subscriptionDaysLeft,
        repliesUsed: user.repliesUsed,
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.'
    });
  }
});

// ============================================
// LOGIN
// ============================================
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Generate token
    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Welcome back!',
      token,
      user: {
        id: user._id,
        email: user.email,
        businessName: user.businessName,
        plan: user.plan,
        isVerified: user.isVerified,
        trialEnds: user.trialEnds,
        isSubscribed: user.isSubscribed,
        subscriptionDaysLeft: user.subscriptionDaysLeft,
        repliesUsed: user.repliesUsed,
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
});

// ============================================
// VERIFY EMAIL (optional – if you want manual verification)
// ============================================
router.post('/verify', async (req, res) => {
  // Keep as is – already defined
  // ...
});

// ============================================
// RESEND CODE
// ============================================
router.post('/resend-code', async (req, res) => {
  // Keep as is
  // ...
});

module.exports = router;