'use strict';

/**
 * GoLive Asia events via advisoryapps API.
 * Output shape matches existing scrapers:
 * id, title, url, date, time, venue, city, image, isFree, price, category, summary
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const BASE_WEB = 'https://www.golive-asia.com';
const API_URL = 'https://golive-production.advisoryapps.com/api/event/list';
const REFERER = `${BASE_WEB}/event-list`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUTPUT = path.join(__dirname, 'data', 'goliveasia-events.json');

function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function pickCategory(row) {
  const cats = Array.isArray(row.EventDetailCategories)
    ? row.EventDetailCategories
    : [];
  for (const item of cats) {
    const name = item?.EventCategory?.name;
    if (name) return String(name).trim();
  }
  return '';
}

function normalizeEvent(row) {
  const id = String(row.id || '').trim();
  if (!id) return null;

  const dateIso =
    row.start_date ||
    row.EventDates?.[0]?.event_date ||
    '';
  const dateObj = dateIso ? new Date(dateIso) : null;

  const cheapest = parseFloat(String(row.cheapest_ticket || '').replace(/,/g, ''));
  const isFree = Number.isFinite(cheapest) ? cheapest <= 0 : !row.cheapest_ticket;
  const price = isFree
    ? 'Free'
    : Number.isFinite(cheapest)
      ? `${cheapest.toFixed(2)} MYR`
      : '';

  return {
    id,
    title: row.name || 'Untitled',
    url: `${BASE_WEB}/event-detail/${id}`,
    date: dateObj && !Number.isNaN(dateObj.valueOf()) ? dateObj.toISOString().slice(0, 10) : '',
    time: dateObj && !Number.isNaN(dateObj.valueOf()) ? dateObj.toISOString().slice(11, 16) : '',
    venue: row.Venue?.name || 'TBA',
    city: row.Venue?.city || '',
    // Presigned S3 URLs from the API expire after a few hours. The app serves fresh URLs via GET /api/golive-image/:id
    image: id ? `/api/golive-image/${encodeURIComponent(id)}` : '',
    isFree,
    price,
    category: pickCategory(row),
    summary: htmlToText(row.general_information),
  };
}

async function fetchEventList() {
  const { data } = await axios.get(API_URL, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: REFERER,
      Origin: BASE_WEB,
    },
    timeout: 60000,
  });

  const rows = data?.result?.result;
  if (!Array.isArray(rows)) throw new Error('Unexpected GoLive API response format');
  return rows;
}

async function scrapeGoLiveAsia() {
  console.log('📡 GoLive Asia — advisoryapps /api/event/list');

  const rows = await fetchEventList();
  const byId = new Map();

  for (const row of rows) {
    const ev = normalizeEvent(row);
    if (ev) byId.set(ev.id, ev);
  }

  const events = Array.from(byId.values());
  await fs.ensureDir(path.join(__dirname, 'data'));
  await fs.writeJson(OUTPUT, events, { spaces: 2 });

  console.log(`💾 Saved ${events.length} events → ${OUTPUT}`);
  return events;
}

if (require.main === module) {
  scrapeGoLiveAsia().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scrapeGoLiveAsia };
