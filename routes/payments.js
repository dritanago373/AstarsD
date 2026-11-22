// routes/payments.js  ->  app.use('/api/webhooks', paymentsRouter)
//   POST /api/webhooks/paddle       (Paddle Billing notifications)
//   POST /api/webhooks/revenuecat   (Apple + Google via RevenueCat)
// Requires server.js to keep the raw body:  express.json({ verify: (req, res, buf) => { req.rawBody = buf; } })
const express = require('express');
const User = require('../models/User');
const {
  isValidObjectId,
  safeEqual,
  verifyPaddleSignature,
  applyPaddleSubscription,
  applyStoreEvent,
} = require('../services/billing');

const router = express.Router();

// ---------------------------------------------------------------- Paddle
async function findUserForPaddle(data) {
  const uid = data?.custom_data?.userId;
  if (isValidObjectId(uid)) {
    const u = await User.findById(uid);
    if (u) return u;
  }
  if (data?.id) {
    const u = await User.findOne({ paddleSubscriptionId: data.id });
    if (u) return u;
  }
  if (data?.customer_id) return User.findOne({ paddleCustomerId: data.customer_id });
  return null;
}

router.post('/paddle', async (req, res) => {
  const ok = verifyPaddleSignature(req.rawBody, req.get('Paddle-Signature'), process.env.PADDLE_WEBHOOK_SECRET);
  if (!ok) return res.status(400).send('Invalid signature');

  try {
    const event = req.body;
    const type = event?.event_type;

    if (type && type.startsWith('subscription.')) {
      const user = await findUserForPaddle(event.data);
      if (!user) {
        console.warn('Paddle webhook: no matching user for', type, event.data?.id);
        return res.sendStatus(200); // do not make Paddle retry forever
      }

      // Skip out-of-order (older) events
      const at = event.occurred_at ? new Date(event.occurred_at) : new Date();
      if (user.billingEventAt && at < user.billingEventAt) return res.sendStatus(200);

      applyPaddleSubscription(user, event.data);
      user.billingEventAt = at;
      await user.save();
      console.log(`✅ Paddle ${type} -> user ${user.email} (${user.plan}, subscribed=${user.isSubscribed})`);
    }
    // transaction.completed etc. need no action: subscription.* events carry the state.

    res.sendStatus(200);
  } catch (error) {
    console.error('Paddle webhook error:', error);
    res.sendStatus(500); // Paddle will retry
  }
});

// ------------------------------------------------------------ RevenueCat
router.post('/revenuecat', async (req, res) => {
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH; // e.g. "Bearer some-long-random-string"
  const got = req.get('Authorization') || '';
  if (!expected || !safeEqual(got, expected)) return res.sendStatus(401);

  try {
    const ev = req.body?.event;
    if (!ev) return res.sendStatus(200);

    // app_user_id is the id we passed to Purchases.logIn(); fall back to aliases
    const candidates = [ev.app_user_id, ev.original_app_user_id, ...(ev.aliases || [])];
    const userId = candidates.find((id) => isValidObjectId(id));
    if (!userId) return res.sendStatus(200); // anonymous RevenueCat id, nothing to map

    const user = await User.findById(userId);
    if (!user) return res.sendStatus(200);

    const at = ev.event_timestamp_ms ? new Date(Number(ev.event_timestamp_ms)) : new Date();
    if (user.billingEventAt && at < user.billingEventAt) return res.sendStatus(200);

    applyStoreEvent(user, ev);
    user.billingEventAt = at;
    await user.save();
    console.log(`✅ RevenueCat ${ev.type} -> user ${user.email} (${user.plan}, subscribed=${user.isSubscribed})`);

    res.sendStatus(200);
  } catch (error) {
    console.error('RevenueCat webhook error:', error);
    res.sendStatus(500);
  }
});

module.exports = router;