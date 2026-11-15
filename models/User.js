//models/User.js
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
  // Adding these back so it matches what server.js expects
  preferredLanguage: { type: String, default: 'en-US' },
  subscriptionPlan: { type: String, enum: ['single', 'pro', 'business', null], default: null },
  subscriptionStart: { type: Date, default: null },
  subscriptionEnds: { type: Date, default: null },
});

module.exports = mongoose.model('User', UserSchema); // 👈 THIS LINE IS CRITICAL