// routes/google.js
// "Connect with Google": OAuth + Google Business Profile API (read reviews, post replies).
// Mounted in server.js at /api/google
//
// Env vars needed:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET   (OAuth client, type "Web application")
//   GOOGLE_OAUTH_REDIRECT_URI  (optional; default https://astarsd.onrender.com/api/google/callback)
//   TOKEN_ENC_KEY              (optional; falls back to JWT_SECRET) - encrypts stored refresh tokens

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');

const router = express.Router();

const SCOPES = ['https://www.googleapis.com/auth/business.manage', 'openid', 'email'];
const REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || 'https://astarsd.onrender.com/api/google/callback';

const isConfigured = () =>
  !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET;

// ---------- model ----------
const GoogleConnection =
  mongoose.models.GoogleConnection ||
  mongoose.model(
    'GoogleConnection',
    new mongoose.Schema({
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
      email: String,
      refreshTokenEnc: { type: String, required: true },
      connectedAt: { type: Date, default: Date.now },
    })
  );

// ---------- token encryption (AES-256-GCM) ----------
const encKey = () =>
  crypto
    .createHash('sha256')
    .update(process.env.TOKEN_ENC_KEY || process.env.JWT_SECRET || 'secret')
    .digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(payload) {
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---------- Google helpers ----------
class GoogleError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const accessCache = new Map(); // userId -> { token, exp }

async function getAccessToken(userId) {
  const key = String(userId);
  const cached = accessCache.get(key);
  if (cached && cached.exp > Date.now() + 30000) return cached.token;

  const conn = await GoogleConnection.findOne({ userId });
  if (!conn) throw new GoogleError('Google account not connected.', 'NOT_CONNECTED', 400);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: decrypt(conn.refreshTokenEnc),
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      await GoogleConnection.deleteOne({ userId });
      accessCache.delete(key);
      throw new GoogleError(
        'Your Google connection expired. Please connect Google again.',
        'NOT_CONNECTED',
        401
      );
    }
    throw new GoogleError('Could not refresh Google access.', 'TOKEN_ERROR', 502);
  }
  accessCache.set(key, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

async function googleFetch(userId, url, options = {}) {
  const token = await getAccessToken(userId);
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }
  if (!resp.ok) {
    const msg = data?.error?.message || `Google API error (${resp.status})`;
    let code = 'GOOGLE_API';
    if (resp.status === 429) code = 'QUOTA';
    if (resp.status === 403) code = 'FORBIDDEN';
    console.error('Google API error:', resp.status, msg);
    throw new GoogleError(msg, code, resp.status);
  }
  return data;
}

const friendly = (e) => {
  if (e.code === 'QUOTA' || e.code === 'FORBIDDEN')
    return 'Google has not enabled Business Profile access for this app yet (approval pending), or the account does not manage this business.';
  return e.message || 'Google request failed.';
};

// ---------- list the locations this Google account manages ----------
async function listLocations(userId) {
  const accounts = await googleFetch(
    userId,
    'https://mybusinessaccountmanagement.googleapis.com/v1/accounts'
  );
  const out = [];
  for (const acc of accounts.accounts || []) {
    let pageToken = '';
    do {
      const url =
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations` +
        `?readMask=name,title,storefrontAddress&pageSize=100` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const data = await googleFetch(userId, url);
      for (const loc of data.locations || []) {
        const a = loc.storefrontAddress || {};
        out.push({
          accountName: acc.name, // accounts/123
          accountLabel: acc.accountName || '',
          locationName: loc.name, // locations/456
          title: loc.title || '',
          address: [...(a.addressLines || []), a.locality].filter(Boolean).join(', '),
        });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
  }
  return out;
}

// ---------- reviews of a linked business (used by sync) ----------
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

async function fetchLinkedReviews(business) {
  const base = `${business.googleAccount}/${business.googleLocation}`;
  const data = await googleFetch(
    business.userId,
    `https://mybusiness.googleapis.com/v4/${base}/reviews?pageSize=50&orderBy=updateTime%20desc`
  );
  const time = (r) => new Date(r.createTime || r.updateTime || 0).getTime();
  const unanswered = (data.reviews || [])
    .filter((r) => !r.reviewReply) // already answered on Google
    .sort((a, b) => time(b) - time(a)); // newest first

  // Only reviews from the last 90 days. A quiet business with fewer than 5 recent
  // reviews still gets its 5 most recent unanswered ones, so it never looks empty.
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recent = unanswered.filter((r) => time(r) >= cutoff);
  const chosen = recent.length >= 5 ? recent : unanswered.slice(0, 5);

  return chosen
    .map((r) => ({
      externalReviewId: `google_${r.reviewId}`,
      googleReviewName: r.name, // accounts/X/locations/Y/reviews/Z
      reviewerName: r.reviewer?.displayName || 'Anonymous',
      reviewerEmail: '',
      rating: STARS[r.starRating] || 0,
      content: r.comment || '',
      platform: 'google',
    }));
}

// ---------- post the reply ----------
async function postReviewReply(userId, googleReviewName, comment) {
  await googleFetch(userId, `https://mybusiness.googleapis.com/v4/${googleReviewName}/reply`, {
    method: 'PUT',
    body: JSON.stringify({ comment: String(comment).slice(0, 4000) }),
  });
}

// =====================  ROUTES  =====================

router.get('/status', auth, async (req, res) => {
  const conn = await GoogleConnection.findOne({ userId: req.user._id });
  res.json({
    success: true,
    data: { configured: isConfigured(), connected: !!conn, email: conn?.email || null },
  });
});

router.get('/connect-url', auth, (req, res) => {
  if (!isConfigured())
    return res
      .status(503)
      .json({ success: false, message: 'Google connection is not set up on the server yet.' });
  const state = jwt.sign({ uid: String(req.user._id), p: 'google-oauth' }, process.env.JWT_SECRET || 'secret', {
    expiresIn: '10m',
  });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  res.json({ success: true, data: { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` } });
});

const page = (title, msg) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f7;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{background:#fff;padding:32px;border-radius:16px;max-width:360px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{color:#555;margin:0}</style></head>
<body><div class="c"><h1>${title}</h1><p>${msg}</p></div></body></html>`;

router.get('/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(page('Not connected', 'Google access was cancelled. You can close this tab and try again.'));
    if (!code || !state) return res.status(400).send(page('Not connected', 'Missing data from Google.'));

    let decoded;
    try {
      decoded = jwt.verify(String(state), process.env.JWT_SECRET || 'secret');
    } catch (_) {
      return res.status(400).send(page('Link expired', 'Please go back to the app and tap Connect with Google again.'));
    }
    if (decoded.p !== 'google-oauth') return res.status(400).send(page('Not connected', 'Invalid request.'));

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.refresh_token) {
      console.error('Google token exchange failed:', tokens.error, tokens.error_description);
      return res.status(400).send(page('Not connected', 'Google did not return access. Please try again.'));
    }

    let email = null;
    try {
      if (tokens.id_token) {
        email = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()).email || null;
      }
    } catch (_) {}

    await GoogleConnection.findOneAndUpdate(
      { userId: decoded.uid },
      { userId: decoded.uid, email, refreshTokenEnc: encrypt(tokens.refresh_token), connectedAt: new Date() },
      { upsert: true, new: true }
    );
    accessCache.delete(String(decoded.uid));

    res.send(page('Google connected ✅', 'You can close this tab and return to the AstarsD app.'));
  } catch (e) {
    console.error('Google callback error:', e.message);
    res.status(500).send(page('Something went wrong', 'Please go back to the app and try again.'));
  }
});

router.get('/locations', auth, async (req, res) => {
  try {
    res.json({ success: true, data: await listLocations(req.user._id) });
  } catch (e) {
    res.status(e.status && e.status < 500 ? e.status : 502).json({ success: false, code: e.code, message: friendly(e) });
  }
});

// Link one of the user's businesses to a Google location they own (this proves ownership).
router.post('/link', auth, async (req, res) => {
  try {
    const { businessId, accountName, locationName } = req.body || {};
    if (!businessId || !accountName || !locationName)
      return res.status(400).json({ success: false, message: 'businessId, accountName and locationName are required.' });

    const Business = mongoose.model('Business');
    const business = await Business.findOne({ _id: businessId, userId: req.user._id });
    if (!business) return res.status(404).json({ success: false, message: 'Business not found.' });

    const owned = (await listLocations(req.user._id)).find(
      (l) => l.accountName === accountName && l.locationName === locationName
    );
    if (!owned)
      return res.status(403).json({ success: false, message: 'This Google account does not manage that location.' });

    business.platform = 'google';
    business.googleAccount = accountName;
    business.googleLocation = locationName;
    business.googleVerified = true;
    await business.save();
    res.json({ success: true, message: `${business.name} is now connected to Google.`, data: business });
  } catch (e) {
    res.status(e.status && e.status < 500 ? e.status : 502).json({ success: false, code: e.code, message: friendly(e) });
  }
});

router.post('/disconnect', auth, async (req, res) => {
  try {
    const conn = await GoogleConnection.findOne({ userId: req.user._id });
    if (conn) {
      try {
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: decrypt(conn.refreshTokenEnc) }),
        });
      } catch (_) {}
      await conn.deleteOne();
    }
    accessCache.delete(String(req.user._id));
    const Business = mongoose.model('Business');
    await Business.updateMany(
      { userId: req.user._id },
      { $unset: { googleAccount: '', googleLocation: '' }, $set: { googleVerified: false } }
    );
    res.json({ success: true, message: 'Google disconnected.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
module.exports.fetchLinkedReviews = fetchLinkedReviews;
module.exports.postReviewReply = postReviewReply;
module.exports.GoogleError = GoogleError;