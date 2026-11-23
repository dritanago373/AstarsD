require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const OpenAI = require('openai');
const auth = require('./middleware/auth');
const paymentsRouter = require('./routes/payments');
const subscriptionRouter = require('./routes/subscription');
const googleRouter = require('./routes/google');
const { hasActiveSubscription, safeEqual } = require('./services/billing');
const User = require('./models/User');
const app = express();

// Keep the raw body: Paddle webhook signatures are verified against it
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/', (req, res) => {
  res.send('AstarsD Backend is live!');
});

// ============ CORS – allow your domains ============
// (The extra open `app.use(cors())` was removed: it made the allow-list below pointless.)
app.use(cors({
  origin: [
    'https://astarsd.app',
    'https://www.astarsd.app',
    'https://api.astarsd.app',
    'https://app.astarsd.app',
    'https://astarsdapp.vercel.app',
    'http://localhost:3000',   // React dev
    'http://localhost:8081',   // React Native / Expo local
    'http://localhost:19006'   // Expo web local
  ],
  credentials: true
}));

// ============ CONNECT DATABASE ============
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/AstarsD')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// ============ OPENAI ============
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ============ ALL LANGUAGES ============
const SUPPORTED_LANGUAGES = {
  'en-US': { name: 'English (US)', code: 'en-US', flag: '🇺🇸' },
  'en-GB': { name: 'English (UK)', code: 'en-GB', flag: '🇬🇧' },
  'it': { name: 'Italiano', code: 'it', flag: '🇮🇹' },
  'de': { name: 'Deutsch', code: 'de', flag: '🇩🇪' },
  'fr': { name: 'Français', code: 'fr', flag: '🇫🇷' },
  'es': { name: 'Español', code: 'es', flag: '🇪🇸' },
  'sq': { name: 'Shqip', code: 'sq', flag: '🇦🇱' },
  'bs': { name: 'Bosanski', code: 'bs', flag: '🇧🇦' },
  'hr': { name: 'Hrvatski', code: 'hr', flag: '🇭🇷' },
  'sr': { name: 'Srpski', code: 'sr', flag: '🇷🇸' },
  'mk': { name: 'Македонски', code: 'mk', flag: '🇲🇰' },
};

const LANGUAGE_PROMPTS = {
  'en-US': 'Write the reply in American English.',
  'en-GB': 'Write the reply in British English.',
  'it': 'Scrivi la risposta in Italiano.',
  'de': 'Schreibe die Antwort auf Deutsch.',
  'fr': 'Écris la réponse en Français.',
  'es': 'Escribe la respuesta en Español.',
  'sq': 'Shkruani përgjigjen në Shqip.',
  'bs': 'Napišite odgovor na Bosanskom.',
  'hr': 'Napišite odgovor na Hrvatskom.',
  'sr': 'Напишите одговор на Српском.',
  'mk': 'Напишете одговор на Македонски.',
};

// ============ EMAIL TRANSPORTER – SMTP from .env ============
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendEmail({ to, subject, html }) {
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'AstarsD <onboarding@resend.dev>',
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return;
  }
  // Fallback: old SMTP (works on a local computer, blocked on Render free)
  await transporter.sendMail({
    from: `"AstarsD" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });
}

async function sendVerificationEmail(to, code, businessName) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1A2A3A; color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f5f5f5; padding: 30px; border-radius: 0 0 10px 10px; }
        .code { font-size: 36px; font-weight: bold; color: #1A2A3A; text-align: center; padding: 20px; background: white; border-radius: 10px; margin: 20px 0; letter-spacing: 8px; }
        .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🌍 AstarsD</h1>
      </div>
      <div class="content">
        <h2>Hello ${businessName || 'there'}! 👋</h2>
        <p>Thank you for signing up! Please verify your email address.</p>
        <div class="code">${code}</div>
        <p>This code expires in <strong>5 minutes</strong>.</p>
        <p>If you didn't request this, please ignore this email.</p>
      </div>
      <div class="footer">
        <p>© 2024 AstarsD. All rights reserved.</p>
      </div>
    </body>
    </html>
  `;

  await sendEmail({ to, subject: 'Verify Your Email - AstarsD', html });
}
async function sendResetEmail(to, code, businessName) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#1A2A3A;color:#fff;padding:20px;text-align:center;border-radius:10px 10px 0 0">
        <h1 style="margin:0">★ AstarsD</h1>
      </div>
      <div style="background:#f5f5f5;padding:30px;border-radius:0 0 10px 10px">
        <h2>Hello ${businessName || 'there'},</h2>
        <p>We received a request to reset your password. Use this code:</p>
        <div style="font-size:36px;font-weight:bold;color:#1A2A3A;text-align:center;padding:20px;background:#fff;border-radius:10px;margin:20px 0;letter-spacing:8px">${code}</div>
        <p>This code expires in <strong>15 minutes</strong>.</p>
        <p>If you didn't request this, you can ignore this email. Your password won't change.</p>
      </div>
    </div>`;
  await sendEmail({ to, subject: 'Reset your password - AstarsD', html });
}
async function sendNewReviewsEmail(to, count, businessName, bizName) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#1A2A3A;color:#fff;padding:20px;text-align:center;border-radius:10px 10px 0 0">
        <h1 style="margin:0">&#9733; AstarsD</h1>
      </div>
      <div style="background:#f5f5f5;padding:30px;border-radius:0 0 10px 10px">
        <h2>Hello ${businessName || 'there'},</h2>
        <p>You have <strong>${count} new review${count === 1 ? '' : 's'}</strong> for <strong>${bizName}</strong> with AI replies ready for your approval.</p>
        <p style="text-align:center;margin:28px 0">
          <a href="https://astarsdapp.vercel.app" style="background:#1A2A3A;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:bold">Review and approve</a>
        </p>
        <p style="color:#888;font-size:12px">You can turn these emails off any time in the app: Settings, Preferences, Email notifications.</p>
      </div>
    </div>`;
  await sendEmail({ to, subject: `${count} new review${count === 1 ? '' : 's'} waiting - AstarsD`, html });
}
// ============ MODELS ============
// NOTE: add the billing fields from models/User.additions.js to your User schema.

const BusinessSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  platform: { type: String, enum: ['google', 'facebook', 'yelp', 'other'], default: 'other' },
  externalId: { type: String },
  accessToken: { type: String },
  googleAccount: { type: String },   // e.g. accounts/123 (set by "Connect with Google")
  googleLocation: { type: String },  // e.g. locations/456
  googleVerified: { type: Boolean, default: false },
  lastSyncedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});
const Business = mongoose.model('Business', BusinessSchema);

const ReviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  reviewerName: String,
  reviewerEmail: String,
  rating: { type: Number, min: 1, max: 5 },
  content: { type: String, required: true },
  contentLanguage: { type: String, default: 'en-US' },
  platform: { type: String, enum: ['google', 'facebook', 'yelp', 'other'], default: 'other' },
  isFake: { type: Boolean, default: false },
  fraudScore: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'ai_draft', 'waiting_approval', 'sent', 'rejected'], default: 'pending' },
  externalReviewId: { type: String, unique: true, sparse: true },
  googleReviewName: { type: String }, // accounts/X/locations/Y/reviews/Z (needed to post a reply)
  createdAt: { type: Date, default: Date.now }
});
const Review = mongoose.model('Review', ReviewSchema);

const ReplySchema = new mongoose.Schema({
  reviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  draft: { type: String, required: true },
  final: String,
  language: { type: String, default: 'en-US' },
  status: { type: String, enum: ['draft', 'approved', 'edited', 'sent', 'rejected'], default: 'draft' },
  approvedAt: Date,
  sentAt: Date,
  editHistory: [String],
  createdAt: { type: Date, default: Date.now }
});
const Reply = mongoose.model('Reply', ReplySchema);

// ============ MIDDLEWARE ============

const checkAccess = async (req, res, next) => {
  const user = req.user;

  // ✅ Paid access (Paddle, App Store or Google Play) — stays valid until the paid period ends
  if (hasActiveSubscription(user)) {
    return next();
  }

  // ✅ Free users: Check if trial is still active (14 days)
  const isTrialValid = user.trialEnds && user.trialEnds > new Date();
  if (!isTrialValid) {
    return res.status(403).json({
      success: false,
      message: 'Your 14-day free trial has ended. Please subscribe to continue using AstarsD.',
      trialEnded: true
    });
  }

  // ✅ Trial is active – allow unlimited access
  next();
};

// ============ HELPER: Consistent user response ============
const getUserResponse = (user) => {
  const active = hasActiveSubscription(user);
  let subscriptionDaysLeft = 0;
  if (active && user.subscriptionEnds) {
    subscriptionDaysLeft = Math.max(0, Math.ceil((user.subscriptionEnds - new Date()) / (1000 * 60 * 60 * 24)));
  } else if (user.trialEnds) {
    subscriptionDaysLeft = Math.max(0, Math.ceil((user.trialEnds - new Date()) / (1000 * 60 * 60 * 24)));
  }
  return {
    id: user._id,
    email: user.email,
    businessName: user.businessName,
    plan: user.plan,
    isVerified: user.isVerified,
    trialEnds: user.trialEnds,
    isSubscribed: active,
    billingProvider: active ? user.billingProvider || null : null,
    cancelAtPeriodEnd: active ? !!user.cancelAtPeriodEnd : false,
    currentPeriodEnd: active ? user.subscriptionEnds || null : null,
    subscriptionDaysLeft,
    repliesUsed: user.repliesUsed,
    monthlyLimit: user.monthlyLimit,
    preferredLanguage: user.preferredLanguage,
    emailNotifications: user.emailNotifications !== false,
  };
};

// ============ SERVICES ============

function detectLanguage(text) {
  const patterns = {
    'en-US': /\b(the|and|for|with|you|your|review|service|great|good|best|color|center|organize)\b/i,
    'en-GB': /\b(the|and|for|with|you|your|review|service|great|good|best|colour|centre|organise)\b/i,
    'it': /\b(il|lo|la|e|per|con|tu|tuo|recensione|servizio|ottimo|buono|migliore|grazie)\b/i,
    'de': /\b(der|die|das|und|für|mit|sie|ihr|bewertung|service|großartig|gut|beste|danke)\b/i,
    'fr': /\b(le|la|les|et|pour|avec|vous|votre|avis|service|excellent|bon|meilleur|merci)\b/i,
    'es': /\b(el|la|los|las|y|para|con|usted|su|reseña|servicio|excelente|bueno|mejor|gracias)\b/i,
    'sq': /\b(dhe|për|me|ju|juaj|shërbim|shqyrtim|mirë|më|i|të|faleminderit)\b/i,
    'bs': /\b(i|sa|za|sa|vas|vaš|usluga|recenzija|odličan|dobar|najbolji|hvala)\b/i,
    'hr': /\b(i|sa|za|vas|vaš|usluga|recenzija|odličan|dobar|najbolji|hvala)\b/i,
    'sr': /\b(и|са|за|вас|ваш|услуга|рецензија|одличан|добар|најбољи|хвала)\b/i,
    'mk': /\b(и|со|за|вас|ваш|услуга|рецензија|одличен|добар|најдобар|благодарам)\b/i,
  };
  let detected = 'en-US';
  let maxScore = 0;
  for (const [lang, pattern] of Object.entries(patterns)) {
    const matches = (text.match(pattern) || []).length;
    if (matches > maxScore) {
      maxScore = matches;
      detected = lang;
    }
  }
  return detected;
}

async function generateAIReply(reviewContent, rating, language = 'en-US') {
  try {
    const languageInstruction = LANGUAGE_PROMPTS[language] || LANGUAGE_PROMPTS['en-US'];
    let toneInstruction = '';
    if (rating >= 4) toneInstruction = 'Write a warm, appreciative reply thanking the customer for their positive feedback.';
    else if (rating >= 3) toneInstruction = 'Write a balanced reply acknowledging their feedback and showing appreciation.';
    else toneInstruction = 'Write a professional, apologetic reply addressing their concerns and showing commitment to improvement.';
    const prompt = `Write a professional reply to this ${rating}-star review:

Review: "${reviewContent}"

Instructions:
- ${toneInstruction}
- Address the reviewer's specific points
- Keep it under 150 words
- Be professional and genuine
- ${languageInstruction}
- IMPORTANT: The reply MUST be in the same language as the review

Reply:`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: `You are a professional customer service representative. You write replies in the EXACT SAME LANGUAGE as the review you're responding to. ${languageInstruction}` },
        { role: 'user', content: prompt }
      ],
      max_tokens: 300,
      temperature: 0.7
    });
    return { success: true, content: response.choices[0].message.content.trim(), language };
  } catch (error) {
    console.error('OpenAI Error:', error);
    const fallbackReplies = {
      'en-US': `Thank you for your ${rating}-star review. We appreciate your feedback and will use it to improve our services.`,
      'en-GB': `Thank you for your ${rating}-star review. We appreciate your feedback and will use it to improve our services.`,
      'it': `Grazie per la tua recensione da ${rating} stelle. Apprezziamo il tuo feedback e lo useremo per migliorare i nostri servizi.`,
      'de': `Vielen Dank für Ihre ${rating}-Sterne-Bewertung. Wir schätzen Ihr Feedback und werden es nutzen, um unsere Dienstleistungen zu verbessern.`,
      'fr': `Merci pour votre avis ${rating} étoiles. Nous apprécions vos commentaires et les utiliserons pour améliorer nos services.`,
      'es': `Gracias por tu reseña de ${rating} estrellas. Apreciamos tus comentarios y los usaremos para mejorar nuestros servicios.`,
      'sq': `Faleminderit për vlerësimin tuaj me ${rating} yje. E vlerësojmë reagimin tuaj dhe do ta përdorim për të përmirësuar shërbimet tona.`,
      'bs': `Hvala vam za vašu ocjenu od ${rating} zvjezdica. Cijenimo vašu povratnu informaciju i koristit ćemo je za poboljšanje naših usluga.`,
      'hr': `Hvala vam za vašu ocjenu od ${rating} zvjezdica. Cijenimo vašu povratnu informaciju i koristit ćemo je za poboljšanje naših usluga.`,
      'sr': `Хвала вам за вашу оцену од ${rating} звездица. Ценимо вашу повратну информацију и користићемо је за побољшање наших услуга.`,
      'mk': `Ви благодариме за вашата оценка од ${rating} ѕвезди. Ја цениме вашата повратна информација и ќе ја искористиме за подобрување на нашите услуги.`
    };
    return { success: false, content: fallbackReplies[language] || fallbackReplies['en-US'], language };
  }
}

function detectFakeReviewer(review) {
  let score = 0, reasons = [];
  const content = review.content || '';
  if (content.length < 15) { score += 25; reasons.push('Review too short'); }
  const genericPatterns = [
    /great|amazing|excellent|good|nice|best|awesome/i,
    /ottimo|eccellente|buono|migliore/i,
    /großartig|ausgezeichnet|gut|beste/i,
    /excellent|bon|meilleur/i,
    /excelente|bueno|mejor/i,
    /shkëlqyeshëm|mirë|më i mirë/i,
    /odličan|dobar|najbolji/i,
    /одличан|добар|најбољи/i,
    /одличен|добар|најдобар/i
  ];
  let genericCount = 0;
  genericPatterns.forEach(p => { if (p.test(content)) genericCount++; });
  if (genericCount > 2) { score += 20; reasons.push('Too many generic phrases'); }
  if (content === content.toUpperCase() && content.length > 10) { score += 15; reasons.push('All caps text'); }
  if ((content.match(/!{3,}/g) || []).length > 2) { score += 15; reasons.push('Excessive exclamation marks'); }
  if (review.reviewerEmail) {
    const email = review.reviewerEmail.toLowerCase();
    if (email.includes('temp') || email.includes('fake') || email.includes('test')) {
      score += 20; reasons.push('Suspicious email domain');
    }
  }
  if (review.rating === 5 && content.length < 30) { score += 10; reasons.push('Perfect rating without detail'); }
  return { isFake: score > 35, score, reasons };
}

// ============ EXTERNAL REVIEW FETCHER ============
async function fetchExternalReviews(business) {
  console.log(`🔍 Fetching reviews for ${business.name} (${business.platform})`);

  // GOOGLE (owner-connected: official Business Profile API, replies can be posted)
  if (business.platform === 'google' && business.googleVerified && business.googleLocation) {
    try {
      const reviews = await googleRouter.fetchLinkedReviews(business);
      console.log(`✅ Found ${reviews.length} unanswered reviews via Business Profile API`);
      return reviews;
    } catch (error) {
      console.error('❌ Business Profile API error:', error.message);
      return [];
    }
  }

  // GOOGLE (public Places API: read-only)
  if (business.platform === 'google') {
    try {
      const apiKey = process.env.GOOGLE_API_KEY;
      const placeId = business.externalId;
      if (!apiKey) { console.error('❌ GOOGLE_API_KEY not set'); return []; }
      if (!placeId) { console.error('❌ No Place ID'); return []; }
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&key=${apiKey}&fields=name,rating,reviews,user_ratings_total`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.status !== 'OK') {
        console.error('❌ Google API Error (legacy):', data.status, data.error_message || '');
        // Fallback: Places API (New) for projects where the legacy API is not available
        const r2 = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
          headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'reviews' },
        });
        const d2 = await r2.json();
        if (!r2.ok) { console.error('❌ Google Places (New) error:', r2.status, d2?.error?.message || ''); return []; }
        return (d2.reviews || []).map((rv) => ({
          externalReviewId: `google_${placeId}_${rv.name || rv.publishTime}`,
          reviewerName: rv.authorAttribution?.displayName || 'Anonymous',
          reviewerEmail: '',
          rating: rv.rating || 0,
          content: rv.text?.text || rv.originalText?.text || '',
          platform: 'google',
        }));
      }
      if (!data.result?.reviews || data.result.reviews.length === 0) { console.log(`ℹ️ No reviews on Google`); return []; }
      console.log(`✅ Found ${data.result.reviews.length} reviews on Google`);
      return data.result.reviews.map((review) => ({
        externalReviewId: `google_${placeId}_${review.time}_${review.author_name}`,
        reviewerName: review.author_name || 'Anonymous',
        reviewerEmail: '',
        rating: review.rating || 0,
        content: review.text || '',
        platform: 'google',
      }));
    } catch (error) {
      console.error('❌ Google API Error:', error.message);
      return [];
    }
  }

  // FACEBOOK
  if (business.platform === 'facebook') {
    try {
      const accessToken = business.accessToken || process.env.FACEBOOK_ACCESS_TOKEN;
      const pageId = business.externalId;
      if (!accessToken) { console.error('❌ Facebook Access Token not set'); return []; }
      if (!pageId) { console.error('❌ No Page ID'); return []; }
      const url = `https://graph.facebook.com/v18.0/${pageId}/ratings?access_token=${accessToken}&fields=reviewer{name,email},rating,review_text,created_time,recommendation_type`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.error) { console.error('❌ Facebook API Error:', data.error.message); return []; }
      if (!data.data || data.data.length === 0) { console.log(`ℹ️ No reviews on Facebook`); return []; }
      console.log(`✅ Found ${data.data.length} reviews on Facebook`);
      return data.data.map((review) => ({
        externalReviewId: `fb_${review.id}`,
        reviewerName: review.reviewer?.name || 'Anonymous',
        reviewerEmail: review.reviewer?.email || '',
        rating: review.rating || (review.recommendation_type === 'positive' ? 5 : 1),
        content: review.review_text || '',
        platform: 'facebook',
      }));
    } catch (error) {
      console.error('❌ Facebook API Error:', error.message);
      return [];
    }
  }

  // YELP
  if (business.platform === 'yelp') {
    try {
      const apiKey = business.accessToken || process.env.YELP_API_KEY;
      const businessId = business.externalId;
      if (!apiKey) { console.error('❌ Yelp API Key not set'); return []; }
      if (!businessId) { console.error('❌ No Business ID'); return []; }
      const url = `https://api.yelp.com/v3/businesses/${businessId}/reviews?limit=20&sort_by=newest`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const data = await response.json();
      if (data.error) { console.error('❌ Yelp API Error:', data.error.description); return []; }
      if (!data.reviews || data.reviews.length === 0) { console.log(`ℹ️ No reviews on Yelp`); return []; }
      console.log(`✅ Found ${data.reviews.length} reviews on Yelp`);
      return data.reviews.map((review) => ({
        externalReviewId: `yelp_${review.id}`,
        reviewerName: review.user?.name || 'Anonymous',
        reviewerEmail: '',
        rating: review.rating || 0,
        content: review.text || '',
        platform: 'yelp',
      }));
    } catch (error) {
      console.error('❌ Yelp API Error:', error.message);
      return [];
    }
  }

  console.log(`⚠️ Platform "${business.platform}" not yet integrated`);
  return [];
}

// ============ ROUTES ============

// ---------- AUTH ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, businessName, phone, preferredLanguage } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ success: false, message: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // SECURITY: the plan is NOT taken from the request. Paid plans are only set by payment webhooks.
    const user = new User({
      email,
      password: hashedPassword,
      businessName,
      phone,
      preferredLanguage: preferredLanguage || 'en-US',
      plan: 'single',
      isVerified: false,
      verificationCode,
      verificationCodeExpires: Date.now() + 300000,
      trialEnds: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    });
    await user.save();
    sendVerificationEmail(email, verificationCode, businessName)
      .catch(err => console.error('Email sending failed:', err));

    res.status(201).json({
      success: true,
      message: 'Account created! A verification code has been sent to your email. Please verify your email to activate your account.',
      email: user.email
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ success: false, message: 'User not found' });
    if (user.isVerified) return res.status(400).json({ success: false, message: 'Email already verified' });
    if (user.verificationCode !== code) return res.status(400).json({ success: false, message: 'Invalid verification code' });
    if (Date.now() > user.verificationCodeExpires) return res.status(400).json({ success: false, message: 'Code expired. Please request a new one.' });

    user.isVerified = true;
    user.verificationCode = null;
    user.verificationCodeExpires = null;
    await user.save();

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.json({
      success: true,
      message: 'Email verified successfully!',
      token,
      user: getUserResponse(user)
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/auth/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ success: false, message: 'User not found' });
    if (user.isVerified) return res.status(400).json({ success: false, message: 'Email already verified' });

    const newCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.verificationCode = newCode;
    user.verificationCodeExpires = Date.now() + 300000;
    await user.save();
    await sendVerificationEmail(email, newCode, user.businessName);
    res.json({ success: true, message: 'New verification code sent to your email' });
  } catch (error) {
    console.error('Resend code error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// ---------- FORGOT / RESET PASSWORD ----------
const crypto = require('crypto');
const findUserByEmail = (email) => User.findOne({ email: new RegExp('^' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
const hashCode = (c) => crypto.createHash('sha256').update(String(c)).digest('hex');

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = email ? await findUserByEmail(email) : null;
    if (user) {
      const code = crypto.randomInt(100000, 1000000).toString();
      user.resetCode = hashCode(code);
      user.resetCodeExpires = Date.now() + 15 * 60 * 1000;
      user.resetAttempts = 0;
      await user.save();
      sendResetEmail(user.email, code, user.businessName)
        .catch(err => console.error('Reset email failed:', err));
    }
    // Same answer whether or not the email exists (prevents account guessing)
    res.json({ success: true, message: 'If that email is registered, a reset code has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email, code and new password are required' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    const user = await findUserByEmail(email);
    const bad = () => res.status(400).json({ success: false, message: 'Invalid or expired code' });
    if (!user || !user.resetCode || !user.resetCodeExpires) return bad();
    if (Date.now() > user.resetCodeExpires || user.resetAttempts >= 5) return bad();

    if (user.resetCode !== hashCode(code)) {
      user.resetAttempts += 1;
      await user.save();
      return bad();
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetCode = null;
    user.resetCodeExpires = null;
    user.resetAttempts = 0;
    user.isVerified = true; // they proved they own the email
    await user.save();

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.json({ success: true, message: 'Password updated', token, user: getUserResponse(user) });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// ---------- LOGIN ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    if (!user.isVerified) {
      if (!user.verificationCode) {
        user.isVerified = true;
        await user.save();
      } else {
        return res.status(403).json({
          success: false,
          message: 'Please verify your email first. A verification code was sent to your email.',
          needsVerification: true,
          email: user.email
        });
      }
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: getUserResponse(user)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------- USER ROUTES ----------
app.post('/api/user/change-email', auth, async (req, res) => {
  try {
    const { newEmail } = req.body;
    const userId = req.user.id;
    const existing = await User.findOne({ email: newEmail });
    if (existing) return res.status(400).json({ success: false, message: 'Email already in use' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const user = await User.findById(userId);
    user.pendingEmail = newEmail;
    user.pendingEmailCode = code;
    user.pendingEmailCodeExpires = Date.now() + 300000;
    await user.save();
    await sendVerificationEmail(newEmail, code, user.businessName);
    res.json({ success: true, message: 'Verification code sent to new email' });
  } catch (error) {
    console.error('Change email error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/user/verify-email-change', auth, async (req, res) => {
  try {
    const { newEmail, code } = req.body;
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (user.pendingEmail !== newEmail) return res.status(400).json({ success: false, message: 'Email mismatch' });
    if (user.pendingEmailCode !== code) return res.status(400).json({ success: false, message: 'Invalid verification code' });
    if (Date.now() > user.pendingEmailCodeExpires) return res.status(400).json({ success: false, message: 'Code expired' });

    user.email = newEmail;
    user.pendingEmail = null;
    user.pendingEmailCode = null;
    user.pendingEmailCodeExpires = null;
    user.isVerified = true;
    await user.save();
    res.json({ success: true, message: 'Email updated successfully!' });
  } catch (error) {
    console.error('Verify email change error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/user/change-password', auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const userId = req.user.id;
    const user = await User.findById(userId);
    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true, message: 'Password updated successfully!' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/user/business-name', auth, async (req, res) => {
  try {
    const { businessName } = req.body;
    const userId = req.user.id;
    const user = await User.findById(userId);
    user.businessName = businessName;
    await user.save();
    res.json({
      success: true,
      message: 'Business name updated successfully!',
      user: getUserResponse(user)
    });
  } catch (error) {
    console.error('Change business name error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/user/notifications', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    user.emailNotifications = !!req.body.emailNotifications;
    await user.save();
    res.json({ success: true, user: getUserResponse(user) });
  } catch (error) {
    console.error('Notifications update error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// REMOVED (security): PUT /api/user/upgrade, POST /api/user/subscribe, POST /api/user/unsubscribe.
// They let any logged-in user grant themselves a paid plan for free. Plans now change only through
// payment webhooks (routes/payments.js) and /api/user/subscription/* (routes/subscription.js).

// ---------- BUSINESS ROUTES ----------
app.get('/api/businesses', auth, async (req, res) => {
  try {
    const businesses = await Business.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: businesses });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/businesses', auth, async (req, res) => {
  try {
    const { name, platform, externalId, accessToken } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Business name is required' });

    const plan = req.user.plan || 'single';
    const count = await Business.countDocuments({ userId: req.user._id });
    const limit = plan === 'pro' ? 5 : plan === 'business' ? Infinity : 1;
    if (count >= limit) {
      return res.status(403).json({ success: false, message: `Plan limit reached (max ${limit === Infinity ? 'unlimited' : limit} businesses)` });
    }

    const business = new Business({
      userId: req.user._id,
      name,
      platform: platform || 'other',
      externalId: externalId || '',
      accessToken: accessToken || '',
    });
    await business.save();
    res.json({ success: true, business });
  } catch (error) {
    console.error('Add business error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// NEW: the app's "Edit business" calls PUT /api/businesses/:id, which did not exist
app.put('/api/businesses/:id', auth, async (req, res) => {
  try {
    const { name, platform, externalId } = req.body;
    const business = await Business.findOne({ _id: req.params.id, userId: req.user._id });
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ success: false, message: 'Business name is required' });
      business.name = String(name).trim();
    }
    if (platform !== undefined) {
      if (!['google', 'facebook', 'yelp', 'other'].includes(platform)) {
        return res.status(400).json({ success: false, message: 'Invalid platform' });
      }
      business.platform = platform;
    }
    if (externalId !== undefined) business.externalId = externalId;

    await business.save();
    res.json({ success: true, business });
  } catch (error) {
    console.error('Edit business error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/businesses/:id', auth, async (req, res) => {
  try {
    const business = await Business.findOne({ _id: req.params.id, userId: req.user._id });
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    // Remove the business together with its reviews and replies (so nothing is left orphaned)
    const reviewIds = (await Review.find({ businessId: business._id, userId: req.user._id }).select('_id')).map((r) => r._id);
    await Reply.deleteMany({ reviewId: { $in: reviewIds } });
    await Review.deleteMany({ _id: { $in: reviewIds } });
    await business.deleteOne();
    res.json({ success: true, message: 'Business deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------- PLACE SEARCH (lets clients find their business by name instead of a Place ID) ----------
// Small per-user limiter so nobody can burn your Google API quota: 30 searches per minute.
const placeSearchHits = new Map();
const placeSearchLimiter = (req, res, next) => {
  const key = String(req.user._id);
  const now = Date.now();
  const recent = (placeSearchHits.get(key) || []).filter((t) => now - t < 60000);
  if (recent.length >= 30) {
    return res.status(429).json({ success: false, message: 'Too many searches. Please wait a minute.' });
  }
  recent.push(now);
  placeSearchHits.set(key, recent);
  next();
};

// GET /api/places/search?q=coffee shop rome  ->  [{ id, name, address, rating, reviewCount }]
app.get('/api/places/search', auth, placeSearchLimiter, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (q.length < 3) return res.json({ success: true, data: [] });

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ success: false, message: 'Business search is not configured.' });
    }

    // 1) Legacy Places API (works for older Google Cloud projects)
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'ZERO_RESULTS') return res.json({ success: true, data: [] });
    if (data.status === 'OK') {
      const results = (data.results || []).slice(0, 6).map((p) => ({
        id: p.place_id,
        name: p.name,
        address: p.formatted_address || '',
        rating: p.rating || null,
        reviewCount: p.user_ratings_total || 0,
      }));
      return res.json({ success: true, data: results });
    }
    console.error('Places (legacy) search error:', data.status, data.error_message || '');

    // 2) Places API (New): new Google Cloud projects can only use this one
    const r2 = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount',
      },
      body: JSON.stringify({ textQuery: q, pageSize: 6 }),
    });
    const d2 = await r2.json();
    if (!r2.ok) {
      console.error('Places (New) search error:', r2.status, d2?.error?.status, d2?.error?.message || '');
      return res.status(502).json({ success: false, message: 'Business search is unavailable right now.' });
    }
    const results2 = (d2.places || []).slice(0, 6).map((p) => ({
      id: p.id,
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      rating: p.rating || null,
      reviewCount: p.userRatingCount || 0,
    }));
    res.json({ success: true, data: results2 });
  } catch (error) {
    console.error('Place search error:', error.message);
    res.status(500).json({ success: false, message: 'Business search failed.' });
  }
});

// ---------- SYNC ROUTE (now requires trial or subscription: it calls OpenAI) ----------
app.post('/api/businesses/:id/sync', auth, checkAccess, async (req, res) => {
  try {
    const business = await Business.findOne({ _id: req.params.id, userId: req.user._id });
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });

    const externalReviews = await fetchExternalReviews(business);
    let newReviewsCount = 0;

    for (const extReview of externalReviews) {
      const existing = await Review.findOne({ externalReviewId: extReview.externalReviewId });
      if (existing) continue;

      const detectedLanguage = detectLanguage(extReview.content);

      const review = new Review({
        userId: req.user._id,
        businessId: business._id,
        reviewerName: extReview.reviewerName,
        reviewerEmail: extReview.reviewerEmail || '',
        rating: extReview.rating || 0,
        content: extReview.content || '',
        platform: extReview.platform || business.platform,
        contentLanguage: detectedLanguage,
        externalReviewId: extReview.externalReviewId,
        googleReviewName: extReview.googleReviewName,
        status: 'pending'
      });

      const fraudResult = detectFakeReviewer(review);
      review.fraudScore = fraudResult.score;
      review.isFake = fraudResult.isFake;

      await review.save();
      newReviewsCount++;

      const aiReply = await generateAIReply(review.content, review.rating, detectedLanguage);
      const reply = new Reply({
        reviewId: review._id,
        userId: req.user._id,
        draft: aiReply.content,
        language: detectedLanguage,
        status: 'draft'
      });
      await reply.save();

      review.status = 'waiting_approval';
      await review.save();
    }

    business.lastSyncedAt = new Date();
    await business.save();

    if (newReviewsCount > 0 && req.user.emailNotifications !== false) {
      sendNewReviewsEmail(req.user.email, newReviewsCount, req.user.businessName, business.name)
        .catch((err) => console.error('New-reviews email failed:', err));
    }

    res.json({
      success: true,
      message: `Sync completed. ${newReviewsCount} new reviews found and processed.`,
      data: { newReviews: newReviewsCount }
    });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------- REVIEW ROUTES ----------
app.post('/api/reviews', auth, checkAccess, async (req, res) => {
  try {
    const { reviewerName, reviewerEmail, rating, content, platform, businessId } = req.body;
    if (!businessId) {
      return res.status(400).json({ success: false, message: 'businessId is required' });
    }
    const business = await Business.findOne({ _id: businessId, userId: req.user._id });
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found or unauthorized' });
    }

    const detectedLanguage = detectLanguage(content);
    const review = new Review({
      userId: req.user._id,
      businessId: business._id,
      reviewerName,
      reviewerEmail,
      rating,
      content,
      platform: platform || 'other',
      contentLanguage: detectedLanguage
    });
    const fraudResult = detectFakeReviewer(review);
    review.fraudScore = fraudResult.score;
    review.isFake = fraudResult.isFake;
    await review.save();

    const aiReply = await generateAIReply(content, rating, detectedLanguage);
    const reply = new Reply({
      reviewId: review._id,
      userId: req.user._id,
      draft: aiReply.content,
      language: detectedLanguage,
      status: 'draft'
    });
    await reply.save();

    review.status = 'waiting_approval';
    await review.save();
    req.user.repliesUsed += 1;
    await req.user.save();

    res.status(201).json({
      success: true,
      data: {
        reviewId: review._id,
        replyId: reply._id,
        detectedLanguage,
        replyLanguage: aiReply.language,
        draft: reply.draft,
        isFake: review.isFake,
        fraudScore: review.fraudScore,
        fraudReasons: fraudResult.reasons,
        status: review.status
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/reviews/pending', auth, async (req, res) => {
  try {
    const allPending = await Review.find({ userId: req.user._id, status: 'waiting_approval' })
      .populate('businessId', 'name')
      .sort({ createdAt: -1 });

    // Clean up leftovers from businesses that were deleted earlier (their business no longer exists)
    const orphanIds = allPending.filter((r) => !r.businessId).map((r) => r._id);
    if (orphanIds.length) {
      await Reply.deleteMany({ reviewId: { $in: orphanIds } });
      await Review.deleteMany({ _id: { $in: orphanIds } });
    }
    const reviews = allPending.filter((r) => r.businessId);

    const reviewsWithReplies = await Promise.all(reviews.map(async (review) => {
      const reply = await Reply.findOne({ reviewId: review._id });
      return {
        ...review.toObject(),
        business: review.businessId,
        reply: reply ? {
          id: reply._id,
          draft: reply.draft,
          language: reply.language,
          status: reply.status
        } : null
      };
    }));
    res.json({ success: true, data: reviewsWithReplies });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/reviews/history', auth, async (req, res) => {
  try {
    const reviews = await Review.find({ userId: req.user._id })
      .populate('businessId', 'name')
      .sort({ createdAt: -1 }).limit(50);
    const reviewsWithReplies = await Promise.all(reviews.map(async (review) => {
      const reply = await Reply.findOne({ reviewId: review._id });
      return {
        ...review.toObject(),
        business: review.businessId,
        reply: reply ? {
          id: reply._id,
          final: reply.final || reply.draft,
          language: reply.language,
          status: reply.status,
          sentAt: reply.sentAt
        } : null
      };
    }));
    res.json({ success: true, data: reviewsWithReplies });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/reviews/:id', auth, async (req, res) => {
  try {
    const review = await Review.findOne({ _id: req.params.id, userId: req.user._id }).populate('businessId', 'name');
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });
    const reply = await Reply.findOne({ reviewId: review._id });
    res.json({ success: true, data: { review, reply } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------- REPLY ROUTES ----------
app.post('/api/replies/:id/approve', auth, async (req, res) => {
  try {
    const reply = await Reply.findById(req.params.id);
    if (!reply) return res.status(404).json({ success: false, message: 'Reply not found' });
    if (reply.userId.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: 'Unauthorized' });
    reply.final = req.body.final || reply.draft;
    reply.status = 'approved';
    reply.approvedAt = new Date();
    await reply.save();

    // Post directly to Google when the business is connected through "Connect with Google".
    const review = await Review.findById(reply.reviewId);
    let postedToPlatform = false;
    if (review && review.googleReviewName) {
      try {
        await googleRouter.postReviewReply(req.user._id, review.googleReviewName, reply.final);
        postedToPlatform = true;
      } catch (postErr) {
        console.error('Post to Google failed:', postErr.message);
        const msg =
          postErr.code === 'NOT_CONNECTED'
            ? postErr.message
            : 'Reply saved, but Google did not accept it yet. Check your Google connection and try again.';
        return res.status(502).json({ success: false, message: msg, data: reply });
      }
    }

    await Review.findByIdAndUpdate(reply.reviewId, { status: 'sent' });
    reply.status = 'sent';
    reply.sentAt = new Date();
    await reply.save();
    res.json({
      success: true,
      message: postedToPlatform ? 'Reply posted on Google!' : 'Reply approved and sent!',
      data: reply,
      postedToPlatform,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/replies/:id/edit', auth, async (req, res) => {
  try {
    const { content } = req.body;
    const reply = await Reply.findById(req.params.id);
    if (!reply) return res.status(404).json({ success: false, message: 'Reply not found' });
    if (reply.userId.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!reply.editHistory) reply.editHistory = [];
    reply.editHistory.push(reply.draft);
    reply.draft = content;
    reply.status = 'edited';
    await reply.save();
    res.json({ success: true, message: 'Reply updated', data: reply });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/replies/:id/regenerate', auth, async (req, res) => {
  try {
    const reply = await Reply.findById(req.params.id);
    if (!reply) return res.status(404).json({ success: false, message: 'Reply not found' });
    if (reply.userId.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const review = await Review.findById(reply.reviewId);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });
    const targetLanguage = req.body.language || review.contentLanguage || 'en-US';
    const newReply = await generateAIReply(review.content, review.rating, targetLanguage);
    reply.draft = newReply.content;
    reply.language = targetLanguage;
    reply.status = 'draft';
    await reply.save();
    res.json({ success: true, message: 'New reply generated', data: { draft: reply.draft, language: reply.language } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/replies/:id/reject', auth, async (req, res) => {
  try {
    const reply = await Reply.findById(req.params.id);
    if (!reply) return res.status(404).json({ success: false, message: 'Reply not found' });
    if (reply.userId.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: 'Unauthorized' });
    reply.status = 'rejected';
    await reply.save();
    await Review.findByIdAndUpdate(reply.reviewId, { status: 'rejected' });
    res.json({ success: true, message: 'Reply rejected', data: reply });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------- DASHBOARD ----------
app.get('/api/dashboard/stats', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const totalReviews = await Review.countDocuments({ userId });
    const pendingReviews = await Review.countDocuments({ userId, status: 'waiting_approval' });
    const sentReviews = await Review.countDocuments({ userId, status: 'sent' });
    const fakeReviews = await Review.countDocuments({ userId, isFake: true });
    const repliesUsed = req.user.repliesUsed;
    const limit = req.user.monthlyLimit;
    const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const reviewsThisMonth = await Review.countDocuments({ userId, createdAt: { $gte: firstDayOfMonth } });
    const trialEnds = req.user.trialEnds;
    res.json({
      success: true,
      data: {
        totalReviews,
        pendingReviews,
        sentReviews,
        fakeReviews,
        repliesUsed,
        monthlyLimit: limit,
        remainingReplies: Math.max(0, limit - repliesUsed),
        reviewsThisMonth,
        trialDaysLeft: trialEnds ? Math.max(0, Math.ceil((trialEnds - new Date()) / (1000 * 60 * 60 * 24))) : 0,
        isTrialActive: !!trialEnds && trialEnds > new Date(),
        isSubscribed: hasActiveSubscription(req.user),
        subscriptionPlan: req.user.subscriptionPlan,
        preferredLanguage: req.user.preferredLanguage,
        supportedLanguages: SUPPORTED_LANGUAGES
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/languages', (req, res) => {
  res.json({ success: true, data: SUPPORTED_LANGUAGES });
});

// ---------- PLANS ----------
// NOTE: these prices/features differ from the app (15 / 30 / 50 USD). Align them if the app uses this endpoint.
app.get('/api/plans', async (req, res) => {
  try {
    const plans = [
      { id: 'single', name: 'Single Business', price: 0, currency: 'USD', features: ['1 business', '50 replies/month', 'All 11 languages', 'AI fraud detection'] },
      { id: 'pro', name: 'Pro', price: 9.99, currency: 'USD', features: ['5 businesses', 'Unlimited replies', 'All 11 languages', 'Priority support', 'Advanced analytics'] },
      { id: 'business', name: 'Business', price: 19.99, currency: 'USD', features: ['Unlimited businesses', 'Unlimited replies', 'All 11 languages', 'Priority support', 'Advanced analytics', 'Custom branding'] }
    ];
    res.json({ success: true, data: plans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------- SUBSCRIPTION (status, checkout-url, change-plan, cancel) ----------
app.use('/api/user/subscription', subscriptionRouter);

// ---------- REVIEW WEBHOOK (now requires a shared secret) ----------
app.post('/api/webhook/review', async (req, res) => {
  try {
    const secret = process.env.REVIEW_WEBHOOK_SECRET;
    const provided = req.get('x-webhook-secret') || '';
    if (!secret || !safeEqual(provided, secret)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { platform, data } = req.body;
    const user = await User.findOne({ businessEmail: data.businessEmail });
    if (!user) return res.status(404).json({ success: false, message: 'Business not found' });

    const detectedLanguage = detectLanguage(data.content);
    const review = new Review({
      userId: user._id,
      businessId: data.businessId,
      reviewerName: data.reviewerName,
      reviewerEmail: data.reviewerEmail,
      rating: data.rating,
      content: data.content,
      platform,
      contentLanguage: detectedLanguage
    });
    const fraudResult = detectFakeReviewer(review);
    review.fraudScore = fraudResult.score;
    review.isFake = fraudResult.isFake;
    await review.save();

    const aiReply = await generateAIReply(data.content, data.rating, detectedLanguage);
    const reply = new Reply({
      reviewId: review._id,
      userId: user._id,
      draft: aiReply.content,
      language: detectedLanguage,
      status: 'draft'
    });
    await reply.save();
    review.status = 'waiting_approval';
    await review.save();
    res.json({ success: true, message: 'Review received and processed', data: { reviewId: review._id, replyId: reply._id, detectedLanguage, replyLanguage: aiReply.language } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------- PAYMENT WEBHOOKS: /api/webhooks/paddle and /api/webhooks/revenuecat ----------
app.use('/api/webhooks', paymentsRouter);

// ---------- GOOGLE CONNECT (OAuth, link locations, post replies) ----------
app.use('/api/google', googleRouter);

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   🌍 AstarsD SYSTEM                                          ║
║   🤖 AI AUTO-REPLIES IN 11 LANGUAGES                         ║
║   🌐 Live at: https://api.astarsd.app                        ║
║   ✉️  Emails from: ${process.env.EMAIL_USER || 'support@astarsd.app'}   ║
║   📅 Status: RUNNING                                         ║
║   💳 Subscriptions: Paddle + App Store + Google Play         ║
║   🏢 Multi-Business: ENABLED                                 ║
║   🔄 Auto-Sync: ENABLED                                      ║
╚══════════════════════════════════════════════════════════════╝
  `);
});