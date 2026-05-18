/**
 * Cookie session + /api/auth/* routes for viewer sign-in / sign-up.
 */
'use strict';

const crypto = require('crypto');
const authStore = require('./auth-store');

const COOKIE_NAME = 'ts_session';
const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;

function sessionSecret() {
  return String(process.env.SESSION_SECRET || 'dev-change-me-in-production').trim();
}

function createSessionToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, iat: Date.now() }),
    'utf8',
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.uid) return null;
    if (typeof data.iat !== 'number' || Date.now() - data.iat > SESSION_MAX_MS) return null;
    return String(data.uid);
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    out[k] = v;
  });
  return out;
}

function getSessionUserId(req) {
  const raw = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  return verifySessionToken(raw);
}

function setSessionCookie(res, userId) {
  const token = createSessionToken(userId);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = Math.floor(SESSION_MAX_MS / 1000);
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function setupAuth(app) {
  app.post('/api/auth/onboarding', async function (req, res) {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const user = await authStore.completeOnboarding(uid, body);
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.json({ user: authStore.publicUser(user) });
    } catch (e) {
      if (e && e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
      console.error('[auth onboarding]', e);
      return res.status(500).json({ error: 'Could not save your answers' });
    }
  });

  app.get('/api/auth/me', async function (req, res) {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ user: null });
    const u = await authStore.findById(uid);
    if (!u) {
      clearSessionCookie(res);
      return res.status(401).json({ user: null });
    }
    return res.json({ user: authStore.publicUser(u) });
  });

  app.post('/api/auth/register', async function (req, res) {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const user = await authStore.createUser(body);
      setSessionCookie(res, user.id);
      return res.status(201).json({ user: authStore.publicUser(user) });
    } catch (e) {
      if (e && e.code === 'DUPLICATE') return res.status(409).json({ error: e.message });
      if (e && (e.code === 'INVALID_EMAIL' || e.code === 'WEAK_PASSWORD')) {
        return res.status(400).json({ error: e.message });
      }
      console.error('[auth register]', e);
      return res.status(500).json({ error: 'Could not create account' });
    }
  });

  app.post('/api/auth/login', async function (req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const u = await authStore.verifyLogin(email, password);
    if (!u) return res.status(401).json({ error: 'Invalid email or password' });
    setSessionCookie(res, u.id);
    return res.json({ user: authStore.publicUser(u) });
  });

  app.post('/api/auth/logout', function (req, res) {
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  app.patch('/api/auth/profile', async function (req, res) {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const user = await authStore.updateProfile(uid, body);
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.json({ user: authStore.publicUser(user) });
    } catch (e) {
      if (e && e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
      console.error('[auth profile]', e);
      return res.status(500).json({ error: 'Could not update profile' });
    }
  });
}

module.exports = {
  setupAuth,
  getSessionUserId,
};
