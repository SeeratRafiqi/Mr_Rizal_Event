'use strict';

/**
 * Ticketmelon public buyer homepage events.
 * Output shape matches other scrapers:
 * id, title, url, date, time, venue, city, image, isFree, price, category, summary
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const API_URL = 'https://api-frontend.ticketmelon.com/v1/buyer/home-page/events';
const BASE_WEB = 'https://www.ticketmelon.com';
const REFERER = `${BASE_WEB}/`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUTPUT = path.join(__dirname, 'data', 'ticketmelon-events.json');
const DETAIL_API_BASE = 'https://api-frontend.ticketmelon.com/v1/buyer/event-page';
const MY_GEO_BOUNDS = {
  minLat: 0.8,
  maxLat: 7.8,
  minLng: 99.5,
  maxLng: 119.5,
};

function toDateParts(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return { date: '', time: '' };
  const d = new Date(n);
  if (Number.isNaN(d.valueOf())) return { date: '', time: '' };
  return {
    date: d.toISOString().slice(0, 10),
    time: d.toISOString().slice(11, 16),
  };
}

function inferCityFromVenueAndUrl(venueName, urlPath) {
  const blob = `${venueName || ''} ${urlPath || ''}`.toLowerCase();
  if (/\b(singapore|marina bay|orchard|raffles|tanjong pagar|little india|sentosa|sg expo)\b/.test(blob)) {
    return 'Singapore';
  }
  if (/\b(bangkok|thailand|bkk|phuket|chiang mai)\b/.test(blob)) return 'Thailand';
  if (/\b(jakarta|bali|indonesia|surabaya)\b/.test(blob)) return 'Indonesia';
  if (/\b(manila|philippines|cebu|makati)\b/.test(blob)) return 'Philippines';
  if (/\b(ho chi minh|hanoi|vietnam)\b/.test(blob)) return 'Vietnam';
  if (/\b(kuala lumpur|petaling|selangor|johor|penang|malacca|melaka)\b/.test(blob)) return 'Malaysia';
  return '';
}

function isPlaceholderVenue(name) {
  const v = String(name || '').trim().toLowerCase();
  if (!v) return true;
  if (/^(tba|tbd|tbh|n\/a|none|[?])$/i.test(v)) return true;
  if (/^(to be announced|to be confirmed|venue tba|location tba)\b/i.test(v)) return true;
  if (/\b(tba|tbd|tbh)\b$/i.test(v)) return true;
  return false;
}

/** IANA zones used by Ticketmelon for Malaysia-only events (API uses these, not e.g. Asia/Singapore). */
const MY_TICKETMELON_TIMEZONES = new Set(['Asia/Kuala_Lumpur', 'Asia/Kuching']);

const MALAYSIA_KEYWORDS_RE =
  /\b(malaysia|kuala lumpur|\bkl\b|selangor|petaling|johor|penang|melaka|malacca|sarawak|sabah|putrajaya|cyberjaya|genting|kuching|kota kinabalu|shah alam|puchong|subang)\b/i;

const NON_MY_GEO_RE =
  /\b(singapore|bangkok|jakarta|manila|cebu|hanoi|ho chi minh|phnom|bali|thailand|indonesia|philippines|vietnam|tokyo|seoul|taipei|hong kong|macau)\b/i;

function inMalaysiaBounds(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= MY_GEO_BOUNDS.minLat &&
    lat <= MY_GEO_BOUNDS.maxLat &&
    lng >= MY_GEO_BOUNDS.minLng &&
    lng <= MY_GEO_BOUNDS.maxLng;
}

/**
 * Strict: Malaysian Ringgit only + Malaysia timezone from API + real venue name.
 * Homepage mixes THB/SGD/PHP/… — those are excluded. Set TICKETMELON_MY_ONLY=0 to disable.
 */
function isMalaysiaTicketmelonEvent(row, ev) {
  if (process.env.TICKETMELON_MY_ONLY === '0') return true;

  const code = String(row?.currency?.code || '').trim().toUpperCase();
  if (code !== 'MYR') return false;

  const tz = String(row?.timezone?.country || '').trim();
  if (!MY_TICKETMELON_TIMEZONES.has(tz)) return false;

  if (isPlaceholderVenue(ev.venue)) return false;

  const venueAddress = String(row?.venue?.address || '');
  const venueName = String(row?.venue?.name || '');
  const blob = `${ev.title || ''} ${ev.url || ''} ${ev.city || ''} ${venueName} ${venueAddress}`.toLowerCase();
  if (NON_MY_GEO_RE.test(blob)) return false;

  const hasMyKeyword = MALAYSIA_KEYWORDS_RE.test(blob);
  const lat = Number(row?.venue?.latitude);
  const lng = Number(row?.venue?.longitude);
  const hasMyCoords = inMalaysiaBounds(lat, lng);
  if (!hasMyKeyword && !hasMyCoords) return false;

  return true;
}

function normalizeEvent(row) {
  const id = String(row.event_id || row.slug || '').trim();
  if (!id) return null;

  const { date, time } = toDateParts(row.show_starttime);
  const categories = Array.isArray(row.categories) ? row.categories : [];
  const venueName = row.venue?.name || 'TBA';
  const webPath = row.eo_slug && row.slug ? `${row.eo_slug}/${row.slug}` : '';

  return {
    id,
    title: row.name || 'Untitled',
    url: row.eo_slug && row.slug ? `${BASE_WEB}/${row.eo_slug}/${row.slug}` : BASE_WEB,
    date,
    time,
    venue: venueName,
    city: inferCityFromVenueAndUrl(venueName, webPath),
    image: row.img_poster || row.img_banner || '',
    isFree: Boolean(row.is_free),
    price: '',
    category: categories[0] || '',
    summary: '',
  };
}

function appHeaders() {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Referer: REFERER,
    Origin: BASE_WEB,
    app_id: 'ticketmelon',
  };
}

function formatPrice(minPrice) {
  if (!Number.isFinite(minPrice)) return '';
  if (minPrice <= 0) return 'Free';
  return `${minPrice.toFixed(2)} MYR`;
}

async function fetchEventMinPrice(eventId) {
  try {
    const { data } = await axios.get(
      `${DETAIL_API_BASE}/${eventId}/ticket-types/default`,
      {
        headers: appHeaders(),
        timeout: 30000,
      }
    );

    const rows = Array.isArray(data?.message) ? data.message : [];
    const prices = rows
      .map((t) => Number(t?.price))
      .filter((n) => Number.isFinite(n) && n >= 0);

    if (!prices.length) return null;
    return Math.min(...prices);
  } catch (_err) {
    return null;
  }
}

async function fetchTicketmelonEvents() {
  const { data } = await axios.get(API_URL, {
    headers: appHeaders(),
    timeout: 60000,
  });

  const rows = Array.isArray(data?.message) ? data.message : [];
  return rows;
}

async function scrapeTicketmelon() {
  console.log('📡 Ticketmelon — buyer/home-page/events');

  const rows = await fetchTicketmelonEvents();
  const byId = new Map();
  let skippedNonMy = 0;

  let i = 0;
  for (const row of rows) {
    i += 1;
    const ev = normalizeEvent(row);
    if (!ev) continue;
    if (!isMalaysiaTicketmelonEvent(row, ev)) {
      skippedNonMy += 1;
      continue;
    }

    const minPrice = await fetchEventMinPrice(ev.id);
    ev.isFree = Number.isFinite(minPrice) ? minPrice <= 0 : ev.isFree;
    ev.price = Number.isFinite(minPrice)
      ? formatPrice(minPrice)
      : ev.isFree
        ? 'Free'
        : 'MYR';

    byId.set(ev.id, ev);
    if (i % 25 === 0) {
      console.log(`   Processed ${i}/${rows.length} events...`);
    }
  }

  const events = Array.from(byId.values());
  await fs.ensureDir(path.join(__dirname, 'data'));
  await fs.writeJson(OUTPUT, events, { spaces: 2 });

  if (skippedNonMy) {
    console.log(
      `   Skipped ${skippedNonMy} rows (not MYR, not Malaysia timezone, or TBA venue — set TICKETMELON_MY_ONLY=0 for homepage mix)`,
    );
  }
  console.log(`💾 Saved ${events.length} events → ${OUTPUT}`);
  return events;
}

if (require.main === module) {
  scrapeTicketmelon().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scrapeTicketmelon };
