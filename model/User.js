// models/User.js
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
});