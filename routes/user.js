const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const User = require('../models/User');
const { sendVerificationEmail } = require('../services/emailService');
const auth = require('../middleware/auth');

// ... (existing endpoints: /change-email, /verify-email-change, /change-password, /business-name, /upgrade) ...

// ============================================
// SUBSCRIBE – activate a plan
// ============================================
router.post('/subscribe', auth, async (req, res) => {
  const { planId } = req.body; // 'single', 'pro', 'business'
  const userId = req.user.id;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Validate planId
    const validPlans = ['single', 'pro', 'business'];
    if (!validPlans.includes(planId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid plan selected'
      });
    }

    // Update user
    user.plan = planId;
    user.isSubscribed = true;
    // Optionally set subscription expiry (e.g., 30 days from now)
    user.subscriptionDaysLeft = 30; // placeholder – you can use a real date
    // Clear trial if any
    user.trialEnds = null;

    await user.save();

    res.json({
      success: true,
      message: `Subscribed to ${planId} plan!`,
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
    console.error('Subscribe error:', error);
    res.status(500).json({
      success: false,
      message: 'Subscription failed. Please try again.'
    });
  }
});

// ============================================
// UNSUBSCRIBE
// ============================================
router.post('/unsubscribe', auth, async (req, res) => {
  const userId = req.user.id;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.isSubscribed = false;
    user.subscriptionDaysLeft = 0;
    // Optionally downgrade plan to 'single'
    // user.plan = 'single';
    await user.save();

    res.json({
      success: true,
      message: 'Unsubscribed successfully.',
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
    console.error('Unsubscribe error:', error);
    res.status(500).json({
      success: false,
      message: 'Unsubscribe failed. Please try again.'
    });
  }
});

// ============================================
// GET STATUS (optional)
// ============================================
router.get('/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch status'
    });
  }
});

module.exports = router;