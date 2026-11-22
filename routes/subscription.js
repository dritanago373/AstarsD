// routes/subscription.js  ->  app.use('/api/user/subscription', subscriptionRouter)
const express = require('express');
const auth = require('../middleware/auth');
const {
  PLAN_ORDER,
  PLAN_PRICE_IDS,
  hasActiveSubscription,
  paddleRequest,
  applyPaddleSubscription,
} = require('../services/billing');

const router = express.Router();

const daysUntil = (d) => (d ? Math.max(0, Math.ceil((new Date(d) - new Date()) / 86400000)) : 0);

// GET /api/user/subscription/status
router.get('/status', auth, async (req, res) => {
  try {
    const user = req.user;
    const active = hasActiveSubscription(user);
    const trialActive = !!user.trialEnds && user.trialEnds > new Date();
    res.json({
      success: true,
      data: {
        isSubscribed: active,
        plan: user.plan || 'single',
        subscriptionPlan: user.subscriptionPlan || null,
        billingProvider: active ? user.billingProvider || null : null,
        cancelAtPeriodEnd: active ? !!user.cancelAtPeriodEnd : false,
        currentPeriodEnd: active ? user.subscriptionEnds || null : null,
        subscriptionStart: user.subscriptionStart || null,
        subscriptionDaysLeft: active ? daysUntil(user.subscriptionEnds) : daysUntil(user.trialEnds),
        trialActive,
        trialDaysLeft: daysUntil(user.trialEnds),
        trialEnds: user.trialEnds || null,
        repliesUsed: user.repliesUsed,
        monthlyLimit: user.monthlyLimit,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/user/subscription/checkout-url   { planId }
// Creates a Paddle transaction for the LOGGED-IN user and returns the hosted checkout URL.
router.post('/checkout-url', auth, async (req, res) => {
  try {
    const { planId } = req.body;
    if (!PLAN_PRICE_IDS[planId]) return res.status(400).json({ success: false, message: 'Invalid plan' });

    const user = req.user;
    if (hasActiveSubscription(user)) {
      const where =
        user.billingProvider === 'paddle'
          ? 'Use "Upgrade/Downgrade" to change your plan.'
          : 'Your subscription is billed by the app store. Manage it there.';
      return res.status(400).json({ success: false, message: `You already have an active subscription. ${where}` });
    }

    const txn = await paddleRequest('POST', '/transactions', {
      items: [{ price_id: PLAN_PRICE_IDS[planId], quantity: 1 }],
      custom_data: { userId: String(user._id), planId },
      ...(user.paddleCustomerId ? { customer_id: user.paddleCustomerId } : {}),
    });

    const checkoutUrl = txn?.checkout?.url;
    if (!checkoutUrl) {
      return res.status(500).json({
        success: false,
        message: 'Paddle did not return a checkout URL. Set a Default payment link in Paddle > Checkout settings.',
      });
    }
    res.json({ success: true, data: { checkoutUrl } });
  } catch (error) {
    console.error('checkout-url error:', error.message);
    res.status(error.status === 400 ? 400 : 500).json({ success: false, message: error.message });
  }
});

// POST /api/user/subscription/change-plan   { planId }   (Paddle subscribers only)
router.post('/change-plan', auth, async (req, res) => {
  try {
    const { planId } = req.body;
    if (!PLAN_PRICE_IDS[planId]) return res.status(400).json({ success: false, message: 'Invalid plan' });

    const user = req.user;
    if (!hasActiveSubscription(user)) {
      return res.status(400).json({ success: false, message: 'No active subscription to change.' });
    }
    if (user.billingProvider !== 'paddle' || !user.paddleSubscriptionId) {
      return res.status(400).json({ success: false, message: 'Your subscription is billed by the app store. Change it there.' });
    }
    if (user.plan === planId) return res.status(400).json({ success: false, message: 'You are already on this plan.' });

    const isUpgrade = PLAN_ORDER.indexOf(planId) > PLAN_ORDER.indexOf(user.plan || 'single');

    // Paddle refuses plan changes while a change is already scheduled (e.g. "cancel at period end").
    // Choosing a new plan means the customer wants to keep the subscription, so remove that scheduled cancel first.
    const current = await paddleRequest('GET', `/subscriptions/${user.paddleSubscriptionId}`);
    const scheduled = current?.scheduled_change;
    if (scheduled) {
      if (scheduled.action === 'cancel') {
        await paddleRequest('PATCH', `/subscriptions/${user.paddleSubscriptionId}`, { scheduled_change: null });
      } else {
        return res.status(409).json({
          success: false,
          message: 'Your subscription has a change scheduled already. Please try again after your next billing date.',
        });
      }
    }

    const updated = await paddleRequest('PATCH', `/subscriptions/${user.paddleSubscriptionId}`, {
      items: [{ price_id: PLAN_PRICE_IDS[planId], quantity: 1 }],
      // Upgrades are charged now (prorated); downgrades take effect at the next billing date.
      proration_billing_mode: isUpgrade ? 'prorated_immediately' : 'prorated_next_billing_period',
    });

    applyPaddleSubscription(user, updated);
    await user.save();
    res.json({ success: true, message: 'Plan updated', data: { plan: user.plan } });
  } catch (error) {
    console.error('change-plan error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/user/subscription/cancel   (Paddle subscribers; access continues until period end)
router.post('/cancel', auth, async (req, res) => {
  try {
    const user = req.user;
    if (!hasActiveSubscription(user)) {
      return res.status(400).json({ success: false, message: 'No active subscription.' });
    }
    if (user.billingProvider !== 'paddle' || !user.paddleSubscriptionId) {
      return res.status(400).json({ success: false, message: 'Your subscription is billed by the app store. Cancel it there.' });
    }

    // Paddle rejects a cancel while another change is already scheduled.
    const current = await paddleRequest('GET', `/subscriptions/${user.paddleSubscriptionId}`);
    const scheduled = current?.scheduled_change;
    if (scheduled && scheduled.action === 'cancel') {
      // Already set to cancel at the end of the period: just sync our records and tell the user.
      applyPaddleSubscription(user, current);
      await user.save();
      return res.json({ success: true, message: 'Your subscription is already set to end at the end of the billing period.' });
    }
    if (scheduled) {
      await paddleRequest('PATCH', `/subscriptions/${user.paddleSubscriptionId}`, { scheduled_change: null });
    }

    const updated = await paddleRequest('POST', `/subscriptions/${user.paddleSubscriptionId}/cancel`, {
      effective_from: 'next_billing_period',
    });

    applyPaddleSubscription(user, updated);
    await user.save();
    res.json({ success: true, message: 'Subscription will end at the end of the billing period.' });
  } catch (error) {
    console.error('cancel error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/user/subscription/resume   (Paddle subscribers: undo a scheduled cancellation before the period ends)
router.post('/resume', auth, async (req, res) => {
  try {
    const user = req.user;
    if (user.billingProvider !== 'paddle' || !user.paddleSubscriptionId) {
      return res.status(400).json({ success: false, message: 'Your subscription is billed by the app store. Resume it there.' });
    }
    const current = await paddleRequest('GET', `/subscriptions/${user.paddleSubscriptionId}`);
    if (current?.status === 'canceled') {
      return res.status(400).json({ success: false, message: 'This subscription has already ended. Please subscribe again.' });
    }
    let result = current;
    if (current?.scheduled_change?.action === 'cancel') {
      result = await paddleRequest('PATCH', `/subscriptions/${user.paddleSubscriptionId}`, { scheduled_change: null });
    }
    applyPaddleSubscription(user, result);
    await user.save();
    res.json({ success: true, message: 'Your subscription will continue and renew as usual.' });
  } catch (error) {
    console.error('resume error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;