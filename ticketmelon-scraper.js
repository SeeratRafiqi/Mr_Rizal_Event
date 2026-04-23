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

function normalizeEvent(row) {
  const id = String(row.event_id || row.slug || '').trim();
  if (!id) return null;

  const { date, time } = toDateParts(row.show_starttime);
  const categories = Array.isArray(row.categories) ? row.categories : [];

  return {
    id,
    title: row.name || 'Untitled',
    url: row.eo_slug && row.slug ? `${BASE_WEB}/${row.eo_slug}/${row.slug}` : BASE_WEB,
    date,
    time,
    venue: row.venue?.name || 'TBA',
    city: '',
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

function formatPrice(minPrice, currencyCode) {
  if (!Number.isFinite(minPrice)) return '';
  if (minPrice <= 0) return 'Free';
  const code = currencyCode || 'MYR';
  return `${minPrice.toFixed(2)} ${code}`;
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

  let i = 0;
  for (const row of rows) {
    i += 1;
    const ev = normalizeEvent(row);
    if (!ev) continue;

    const minPrice = await fetchEventMinPrice(ev.id);
    ev.isFree = Number.isFinite(minPrice) ? minPrice <= 0 : ev.isFree;
    ev.price = formatPrice(minPrice, row.currency?.code);

    byId.set(ev.id, ev);
    if (i % 25 === 0) {
      console.log(`   Processed ${i}/${rows.length} events...`);
    }
  }

  const events = Array.from(byId.values());
  await fs.ensureDir(path.join(__dirname, 'data'));
  await fs.writeJson(OUTPUT, events, { spaces: 2 });

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
