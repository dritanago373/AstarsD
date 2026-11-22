// models/User.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  businessName: { type: String, required: true },
  plan: { type: String, default: 'single' },
  isVerified: { type: Boolean, default: false },
  verificationCode: { type: String },
  verificationCodeExpires: { type: Date },
  pendingEmail: { type: String },
  pendingEmailCode: { type: String },
  pendingEmailCodeExpires: { type: Date },
  isSubscribed: { type: Boolean, default: false },
  subscriptionId: { type: String },
  subscriptionDaysLeft: { type: Number, default: 0 },
  trialEnds: { type: Date },
  repliesUsed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  preferredLanguage: { type: String, default: 'en-US' },
  subscriptionPlan: { type: String, enum: ['single', 'pro', 'business', null], default: null },
  subscriptionStart: { type: Date, default: null },
  subscriptionEnds: { type: Date, default: null },

  // ---- Used by server.js but were missing from the schema (Mongoose silently dropped them) ----
  phone: { type: String },
  businessEmail: { type: String },                 // used by /api/webhook/review
  monthlyLimit: { type: Number, default: 50 },     // shown in the dashboard; adjust to your plan rules

  // ---- NEW: billing fields (Paddle + Apple/Google via RevenueCat) ----
  billingProvider: { type: String, enum: ['paddle', 'apple', 'google', null], default: null },
  paddleCustomerId: { type: String, default: null, index: true },
  paddleSubscriptionId: { type: String, default: null, index: true },
  cancelAtPeriodEnd: { type: Boolean, default: false },
  billingEventAt: { type: Date, default: null },   // lets webhooks ignore out-of-order events
});

module.exports = mongoose.model('User', UserSchema); // 👈 THIS LINE IS CRITICAL