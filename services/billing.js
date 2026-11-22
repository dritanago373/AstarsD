// services/billing.js
// Shared helpers for Paddle (web / link-out) and RevenueCat (Apple + Google) billing.
const crypto = require('crypto');

const PADDLE_BASE =
  process.env.PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';

const PLAN_ORDER = ['single', 'pro', 'business'];

// Paddle price ids (override with env vars when you go to production)
const PLAN_PRICE_IDS = {
  single: process.env.PADDLE_PRICE_SINGLE || 'pri_01m7h6qgxxqtn1656y3e5x0rxg',
  pro: process.env.PADDLE_PRICE_PRO || 'pri_01m7h71hhftxpz7bjav7h41bhn',
  business: process.env.PADDLE_PRICE_BUSINESS || 'pri_01m7h7594ksd8q777pd4z77y9q',
};
const PRICE_TO_PLAN = Object.fromEntries(Object.entries(PLAN_PRICE_IDS).map(([plan, id]) => [id, plan]));

// App Store / Google Play product ids (must match RevenueCat + the app)
const STORE_PRODUCT_TO_PLAN = {
  astarsd_single_monthly: 'single',
  astarsd_pro_monthly: 'pro',
  astarsd_business_monthly: 'business',
};

const GRACE_MS = 3 * 24 * 60 * 60 * 1000; // tolerate a late renewal webhook

const isValidObjectId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);

// Single source of truth for "does this user have paid access right now?"
function hasActiveSubscription(user) {
  if (!user || !user.isSubscribed) return false;
  if (user.subscriptionEnds && new Date(user.subscriptionEnds).getTime() + GRACE_MS < Date.now()) return false;
  return true;
}

async function paddleRequest(method, path, body) {
  if (!process.env.PADDLE_API_KEY) throw new Error('PADDLE_API_KEY is not configured on the server.');
  const res = await fetch(`${PADDLE_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.detail || json?.error?.code || `Paddle error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

// ---------- Paddle webhook signature (header: Paddle-Signature: ts=...;h1=...) ----------
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyPaddleSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!rawBody || !header || !secret) return false;
  let ts = null;
  const h1s = [];
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key === 'ts') ts = val;
    if (key === 'h1') h1s.push(val); // several h1 values exist during secret rotation
  }
  if (!ts || !h1s.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}:${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`)
    .digest('hex');
  return h1s.some((h) => safeEqual(expected, h));
}

// ---------- Apply provider state to the user document ----------
function clearSubscription(user) {
  user.isSubscribed = false;
  user.subscriptionPlan = null;
  user.subscriptionStart = null;
  user.subscriptionEnds = null;
  user.cancelAtPeriodEnd = false;
  user.plan = 'single';
}

// sub = a Paddle subscription entity (webhook data, or API response)
function applyPaddleSubscription(user, sub) {
  // Ignore events for an old subscription once the user has a newer one
  if (user.paddleSubscriptionId && sub.id && user.paddleSubscriptionId !== sub.id && sub.status === 'canceled') return;

  const priceId = sub.items?.[0]?.price?.id;
  const plan = PRICE_TO_PLAN[priceId] || user.plan || 'single';

  user.billingProvider = 'paddle';
  user.paddleCustomerId = sub.customer_id || user.paddleCustomerId;
  user.paddleSubscriptionId = sub.id || user.paddleSubscriptionId;

  if (sub.status === 'canceled' || sub.status === 'paused') {
    clearSubscription(user);
    return;
  }

  // active | trialing | past_due (Paddle retries payment, so keep access during past_due)
  user.isSubscribed = true;
  user.plan = plan;
  user.subscriptionPlan = plan;
  if (!user.subscriptionStart) user.subscriptionStart = sub.started_at ? new Date(sub.started_at) : new Date();
  if (sub.current_billing_period?.ends_at) user.subscriptionEnds = new Date(sub.current_billing_period.ends_at);
  user.cancelAtPeriodEnd = sub.scheduled_change?.action === 'cancel';
}

// ev = RevenueCat webhook event
function applyStoreEvent(user, ev) {
  const store = ev.store === 'APP_STORE' || ev.store === 'MAC_APP_STORE' ? 'apple' : 'google';
  const productId = ev.type === 'PRODUCT_CHANGE' && ev.new_product_id ? ev.new_product_id : ev.product_id;
  const plan = STORE_PRODUCT_TO_PLAN[productId] || user.plan || 'single';
  const expiresAt = ev.expiration_at_ms ? new Date(Number(ev.expiration_at_ms)) : null;

  switch (ev.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'PRODUCT_CHANGE':
    case 'UNCANCELLATION':
      user.billingProvider = store;
      user.isSubscribed = true;
      user.plan = plan;
      user.subscriptionPlan = plan;
      if (!user.subscriptionStart) user.subscriptionStart = new Date();
      if (expiresAt) user.subscriptionEnds = expiresAt;
      user.cancelAtPeriodEnd = false;
      break;

    case 'CANCELLATION':
      // Auto-renew turned off: access continues until expiration. (A refund expires immediately.)
      if (expiresAt && expiresAt.getTime() <= Date.now()) clearSubscription(user);
      else user.cancelAtPeriodEnd = true;
      break;

    case 'EXPIRATION':
      clearSubscription(user);
      break;

    default:
      // BILLING_ISSUE, TEST, TRANSFER, etc.: no state change (grace handled by hasActiveSubscription)
      break;
  }
}

module.exports = {
  PLAN_ORDER,
  PLAN_PRICE_IDS,
  PRICE_TO_PLAN,
  STORE_PRODUCT_TO_PLAN,
  isValidObjectId,
  hasActiveSubscription,
  paddleRequest,
  safeEqual,
  verifyPaddleSignature,
  applyPaddleSubscription,
  applyStoreEvent,
};