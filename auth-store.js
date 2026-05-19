/**
 * Simple JSON-backed user store for preferences & auth (local / demo).
 * For production, migrate to a real database and rotate SESSION_SECRET.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');

const USERS_PATH = path.join(__dirname, 'data', 'users.json');

/** Same city hints as event-hub / itinerary — used when home IATA omitted at signup. */
const CITY_HINT_TO_IATA = [
  [/kuala\s*lumpur|kl\b/i, 'KUL'],
  [/penang|george\s*town|pulau\s*pinang/i, 'PEN'],
  [/johor|jb\b|johor\s*bahru/i, 'JHB'],
  [/kota\s*kinabalu|sabah/i, 'BKI'],
  [/kuching|sarawak/i, 'KCH'],
  [/langkawi/i, 'LGK'],
  [/melaka|malacca/i, 'MKZ'],
  [/ipoh/i, 'IPH'],
  [/kota\s*bharu|kelantan/i, 'KBR'],
  [/terengganu|kuala\s*terengganu/i, 'TGG'],
  [/miri/i, 'MYY'],
  [/singapore/i, 'SIN'],
  [/bangkok/i, 'BKK'],
  [/jakarta/i, 'CGK'],
  [/bali|denpasar/i, 'DPS'],
];

const ALLOWED_GENRES = new Set([
  'music',
  'comedy',
  'sports',
  'arts',
  'family',
  'food',
  'nightlife',
  'tech',
  'wellness',
]);

const ALLOWED_INTERESTS = new Set([
  'food',
  'culture',
  'nature',
  'adventure',
  'shopping',
  'nightlife',
  'family',
  'wellness',
]);

function guessIataFromLocationText(city, country) {
  const blob = `${city || ''} ${country || ''}`;
  for (let i = 0; i < CITY_HINT_TO_IATA.length; i++) {
    if (CITY_HINT_TO_IATA[i][0].test(blob)) return CITY_HINT_TO_IATA[i][1];
  }
  return '';
}

function normalizeIata(raw) {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .slice(0, 3);
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const i = stored.indexOf(':');
  if (i < 1) return false;
  const saltHex = stored.slice(0, i);
  const hashHex = stored.slice(i + 1);
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, 64);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function readDb() {
  try {
    const data = await fs.readJson(USERS_PATH);
    if (data && Array.isArray(data.users)) return data;
  } catch {
    /* missing */
  }
  return { users: [] };
}

async function writeDb(data) {
  await fs.ensureDir(path.dirname(USERS_PATH));
  await fs.writeJson(USERS_PATH, data, { spaces: 2 });
}

function sanitizeGenreList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  arr.forEach(function (x) {
    const k = String(x || '')
      .trim()
      .toLowerCase();
    if (ALLOWED_GENRES.has(k) && out.indexOf(k) === -1) out.push(k);
  });
  return out;
}

function sanitizeInterestList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  arr.forEach(function (x) {
    const k = String(x || '')
      .trim()
      .toLowerCase();
    if (ALLOWED_INTERESTS.has(k) && out.indexOf(k) === -1) out.push(k);
  });
  return out;
}

/** Fresh account — details come from post-signup onboarding quiz. */
function minimalNewProfile(body) {
  const displayName = String(body.displayName || '').trim().slice(0, 80);
  return {
    displayName,
    locationCity: '',
    locationCountry: 'Malaysia',
    homeIata: 'KUL',
    genres: [],
    activityInterests: [],
    adventureLevel: 'medium',
    pacePreference: 'balanced',
    hotelPreference: 'venue',
    travelerType: 'couple',
    marketingOptIn: false,
    notes: '',
    budgetLevel: 2,
    language: '',
    onboardingComplete: false,
    updatedAt: new Date().toISOString(),
  };
}

/** Merged after onboarding quiz (same rules as before, without wiping displayName). */
function buildProfileFromOnboardingBody(body) {
  const locationCity = String(body.locationCity || '').trim().slice(0, 120);
  const locationCountry = String(body.locationCountry || 'Malaysia').trim().slice(0, 80);
  let homeIata = normalizeIata(body.homeIata);
  if (!homeIata) homeIata = guessIataFromLocationText(locationCity, locationCountry) || 'KUL';
  const adventureLevel = ['easy', 'medium', 'hard'].includes(String(body.adventureLevel))
    ? String(body.adventureLevel)
    : 'medium';
  const pacePreference = ['slow', 'balanced', 'packed'].includes(String(body.pacePreference))
    ? String(body.pacePreference)
    : 'balanced';
  let budgetLevel = parseInt(String(body.budgetLevel), 10);
  if (!Number.isFinite(budgetLevel) || budgetLevel < 1 || budgetLevel > 4) budgetLevel = 2;
  const out = {
    locationCity,
    locationCountry,
    homeIata,
    genres: sanitizeGenreList(body.genres),
    activityInterests: sanitizeInterestList(body.activityInterests),
    adventureLevel,
    pacePreference,
    hotelPreference: ['venue', 'nightlife', 'transit', 'luxury', 'budget', 'quiet'].includes(String(body.hotelPreference))
      ? String(body.hotelPreference)
      : 'venue',
    travelerType: ['solo', 'couple', 'family', 'group'].includes(String(body.travelerType))
      ? String(body.travelerType)
      : 'couple',
    budgetLevel,
    marketingOptIn: Boolean(body.marketingOptIn),
    notes: String(body.notes || '')
      .trim()
      .slice(0, 500),
    updatedAt: new Date().toISOString(),
  };
  const lang = String(body.language || '')
    .trim()
    .slice(0, 40);
  if (lang) out.language = lang;
  const dn = String(body.displayName || '').trim().slice(0, 80);
  if (dn) out.displayName = dn;
  return out;
}

function validateOnboardingPayload(body) {
  const genres = sanitizeGenreList(body.genres);
  if (!genres.length) {
    const err = new Error('Pick at least one event type you like');
    err.code = 'VALIDATION';
    throw err;
  }
  const locationCity = String(body.locationCity || '').trim();
  const locationCountry = String(body.locationCountry || '').trim();
  let homeIata = normalizeIata(body.homeIata);
  if (!homeIata) homeIata = guessIataFromLocationText(locationCity, locationCountry);
  if (!homeIata) {
    const err = new Error('Choose a home airport so we can pre-fill flights');
    err.code = 'VALIDATION';
    throw err;
  }
}

async function findByEmail(email) {
  const e = String(email || '')
    .trim()
    .toLowerCase();
  if (!e) return null;
  const db = await readDb();
  return db.users.find(function (u) {
    return u.email === e;
  }) || null;
}

async function findById(id) {
  const db = await readDb();
  return db.users.find(function (u) {
    return u.id === id;
  }) || null;
}

function publicUser(u) {
  if (!u) return null;
  const prof = u.profile || {};
  return {
    id: u.id,
    email: u.email,
    displayName: prof.displayName || '',
    profile: Object.assign({}, prof),
    createdAt: u.createdAt,
  };
}

async function createUser(payload) {
  const email = String(payload.email || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('Invalid email');
    err.code = 'INVALID_EMAIL';
    throw err;
  }
  const password = String(payload.password || '');
  if (password.length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  if (await findByEmail(email)) {
    const err = new Error('An account with this email already exists');
    err.code = 'DUPLICATE';
    throw err;
  }
  const profile = minimalNewProfile(payload);
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    profile,
  };
  const db = await readDb();
  db.users.push(user);
  await writeDb(db);
  return user;
}

async function verifyLogin(email, password) {
  const u = await findByEmail(email);
  if (!u) return null;
  if (!verifyPassword(password, u.passwordHash)) return null;
  return u;
}

async function completeOnboarding(userId, body) {
  validateOnboardingPayload(body);
  const db = await readDb();
  const idx = db.users.findIndex(function (u) {
    return u.id === userId;
  });
  if (idx < 0) return null;
  const u = db.users[idx];
  const built = buildProfileFromOnboardingBody(body);
  const next = Object.assign({}, u.profile || {}, built, {
    onboardingComplete: true,
    updatedAt: new Date().toISOString(),
  });
  db.users[idx].profile = next;
  await writeDb(db);
  return db.users[idx];
}

/**
 * Merge preference fields for signed-in users (same validation as onboarding for genres + home airport).
 * Only keys present on `body` are applied — send a full snapshot from the profile editor.
 */
async function updateProfile(userId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const db = await readDb();
  const idx = db.users.findIndex(function (u) {
    return u.id === userId;
  });
  if (idx < 0) return null;
  const cur = Object.assign({}, db.users[idx].profile || {});

  if (Object.prototype.hasOwnProperty.call(b, 'displayName')) {
    cur.displayName = String(b.displayName || '').trim().slice(0, 80);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'locationCity')) {
    cur.locationCity = String(b.locationCity || '').trim().slice(0, 120);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'locationCountry')) {
    cur.locationCountry = String(b.locationCountry || 'Malaysia').trim().slice(0, 80);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'homeIata')) {
    const hi = normalizeIata(b.homeIata);
    if (hi) cur.homeIata = hi;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'genres')) {
    cur.genres = sanitizeGenreList(b.genres);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'activityInterests')) {
    cur.activityInterests = sanitizeInterestList(b.activityInterests);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'adventureLevel')) {
    cur.adventureLevel = ['easy', 'medium', 'hard'].includes(String(b.adventureLevel))
      ? String(b.adventureLevel)
      : cur.adventureLevel || 'medium';
  }
  if (Object.prototype.hasOwnProperty.call(b, 'pacePreference')) {
    cur.pacePreference = ['slow', 'balanced', 'packed'].includes(String(b.pacePreference))
      ? String(b.pacePreference)
      : cur.pacePreference || 'balanced';
  }
  if (Object.prototype.hasOwnProperty.call(b, 'budgetLevel')) {
    let bl = parseInt(String(b.budgetLevel), 10);
    if (!Number.isFinite(bl) || bl < 1 || bl > 4) bl = Number(cur.budgetLevel) || 2;
    cur.budgetLevel = Math.min(4, Math.max(1, bl));
  }
  if (Object.prototype.hasOwnProperty.call(b, 'marketingOptIn')) {
    cur.marketingOptIn = Boolean(b.marketingOptIn);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'notes')) {
    cur.notes = String(b.notes || '')
      .trim()
      .slice(0, 500);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'language')) {
    const lang = String(b.language || '').trim().slice(0, 40);
    if (lang) cur.language = lang;
    else delete cur.language;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'hotelPreference')) {
    const hp = String(b.hotelPreference || '').trim();
    if (['venue', 'nightlife', 'transit', 'luxury', 'budget', 'quiet'].includes(hp)) cur.hotelPreference = hp;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'travelerType')) {
    const tt = String(b.travelerType || '').trim();
    if (['solo', 'couple', 'family', 'group'].includes(tt)) cur.travelerType = tt;
  }

  let homeIata = normalizeIata(cur.homeIata);
  if (!homeIata) homeIata = guessIataFromLocationText(cur.locationCity, cur.locationCountry);
  if (!homeIata) {
    const err = new Error('Choose a home airport so we can pre-fill flights');
    err.code = 'VALIDATION';
    throw err;
  }
  cur.homeIata = homeIata;

  if (!Array.isArray(cur.genres) || !cur.genres.length) {
    const err = new Error('Pick at least one event type you like');
    err.code = 'VALIDATION';
    throw err;
  }

  cur.updatedAt = new Date().toISOString();
  db.users[idx].profile = cur;
  await writeDb(db);
  return db.users[idx];
}

module.exports = {
  createUser,
  completeOnboarding,
  updateProfile,
  findByEmail,
  findById,
  publicUser,
  verifyLogin,
  guessIataFromLocationText,
  normalizeIata,
  ALLOWED_GENRES,
  ALLOWED_INTERESTS,
};
