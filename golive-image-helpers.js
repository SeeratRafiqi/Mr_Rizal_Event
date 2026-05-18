'use strict';

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const BASE_WEB = 'https://www.golive-asia.com';
const API_URL = 'https://golive-production.advisoryapps.com/api/event/list';
const REFERER = `${BASE_WEB}/event-list`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const GOLIVE_API_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Referer: REFERER,
  Origin: BASE_WEB,
  'Accept-Language': 'en-MY,en;q=0.9',
};

const IMAGE_MAP_PATH = path.join(__dirname, 'data', 'goliveasia-image-map.json');

/**
 * Pull a usable HTTPS image URL from a GoLive list row (handles strings or { url } objects).
 */
function extractGoLiveImageUrl(row) {
  if (!row || typeof row !== 'object') return '';

  const candidates = [];

  const push = (val) => {
    if (typeof val === 'string') {
      const s = val.trim();
      if (s) candidates.push(s);
      return;
    }
    if (!val || typeof val !== 'object') return;
    for (const key of [
      'url',
      'URL',
      'src',
      'path',
      'image_url',
      'imageUrl',
      'full_url',
      'fullUrl',
      'original',
      'thumbnail',
    ]) {
      if (typeof val[key] === 'string' && val[key].trim()) candidates.push(val[key].trim());
    }
  };

  const arrays = [
    row.images,
    row.Images,
    row.event_images,
    row.EventImages,
    row.media,
    row.gallery,
  ];
  for (const arr of arrays) {
    if (Array.isArray(arr)) arr.forEach(push);
  }

  push(row.image);
  push(row.banner);
  push(row.poster);
  push(row.thumbnail);
  push(row.image_url);
  push(row.imageUrl);
  push(row.cover_image);
  push(row.coverImage);

  return (
    candidates.find((u) => /^https?:\/\//i.test(u)) ||
    candidates.find((u) => u.startsWith('//') && `https:${u}`) ||
    ''
  );
}

function proxyImagePathForId(id) {
  const sid = String(id || '').trim();
  return sid ? `/api/golive-image/${encodeURIComponent(sid)}` : '';
}

async function fetchEventListAxios() {
  const { data } = await axios.get(API_URL, {
    headers: GOLIVE_API_HEADERS,
    timeout: 60000,
    validateStatus: (s) => s < 500,
  });
  if (data?.error) {
    throw new Error(String(data.error));
  }
  const rows = data?.result?.result;
  if (!Array.isArray(rows)) throw new Error('Unexpected GoLive API response format');
  return rows;
}

/**
 * Browser-context fetch when Node axios is blocked or returns an error payload.
 */
async function fetchEventListPlaywright() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return null;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-MY',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let rows = null;

    page.on('response', async (res) => {
      if (!res.url().includes('/api/event/list') || res.status() !== 200) return;
      try {
        const j = await res.json();
        if (Array.isArray(j?.result?.result) && j.result.result.length) {
          rows = j.result.result;
        }
      } catch (_) {}
    });

    await page.goto(REFERER, { waitUntil: 'domcontentloaded', timeout: 120000 });

    for (let i = 0; i < 25 && !rows; i++) {
      await page.waitForTimeout(1000);
    }

    if (!rows) {
      const evaluated = await page
        .evaluate(async (apiUrl) => {
          try {
            const res = await fetch(apiUrl, {
              headers: { Accept: 'application/json' },
              credentials: 'include',
            });
            const data = await res.json();
            if (data?.error) return { error: data.error, rows: [] };
            return { rows: data?.result?.result || [] };
          } catch (e) {
            return { error: e.message, rows: [] };
          }
        }, API_URL)
        .catch(() => ({ rows: [] }));

      if (evaluated?.rows?.length) rows = evaluated.rows;
    }

    if (!rows?.length || rows.length < 3) {
      for (let s = 0; s < 10; s++) {
        await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight * 0.85)));
        await page.waitForTimeout(1200);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(800);

      const domRows = await page
        .evaluate(() => {
          const seen = new Map();
          document.querySelectorAll('a[href*="event-detail"]').forEach((a) => {
            const m = (a.getAttribute('href') || a.href || '').match(/event-detail\/(\d+)/i);
            if (!m) return;
            const id = m[1];
            const img =
              a.querySelector('img') ||
              a.closest('[class*="card"],[class*="event"]')?.querySelector('img');
            const src = img?.currentSrc || img?.src || img?.getAttribute('data-src') || '';
            const title =
              a.querySelector('h1,h2,h3,h4,.title')?.textContent?.trim() ||
              a.getAttribute('aria-label') ||
              a.textContent?.trim() ||
              '';
            const prev = seen.get(id) || { id, name: title.slice(0, 200), images: [] };
            if (title && (!prev.name || prev.name.length < title.length)) prev.name = title.slice(0, 200);
            if (src && !prev.images.includes(src)) prev.images.push(src);
            seen.set(id, prev);
          });
          return Array.from(seen.values());
        })
        .catch(() => []);

      if (domRows.length) {
        rows = domRows;
      }
    }

    return rows;
  } finally {
    await browser.close();
  }
}

async function fetchGoLiveEventList() {
  try {
    const rows = await fetchEventListAxios();
    if (rows.length) return { rows, source: 'axios' };
  } catch (err) {
    console.warn('GoLive list API (axios):', err.message);
  }

  const pwRows = await fetchEventListPlaywright();
  if (Array.isArray(pwRows) && pwRows.length) {
    return { rows: pwRows, source: 'playwright' };
  }

  throw new Error('Could not load GoLive event list (API and browser fallback failed)');
}

async function loadGoLiveImageMap() {
  try {
    if (await fs.pathExists(IMAGE_MAP_PATH)) {
      const map = await fs.readJson(IMAGE_MAP_PATH);
      if (map && typeof map === 'object') return map;
    }
  } catch (_) {}
  return {};
}

async function saveGoLiveImageMap(map) {
  await fs.ensureDir(path.dirname(IMAGE_MAP_PATH));
  await fs.writeJson(IMAGE_MAP_PATH, map, { spaces: 2 });
}

async function resolveGoLiveImageUrl(eventId, liveRows) {
  const id = String(eventId || '').trim();
  if (!id) return '';

  const map = await loadGoLiveImageMap();
  if (map[id] && /^https?:\/\//i.test(map[id])) return map[id];

  const rows = liveRows || (await fetchGoLiveEventList()).rows;
  const row = rows.find((r) => String(r.id) === id);
  const fromRow = extractGoLiveImageUrl(row);
  if (fromRow) return fromRow;

  return '';
}

module.exports = {
  BASE_WEB,
  API_URL,
  REFERER,
  GOLIVE_API_HEADERS,
  IMAGE_MAP_PATH,
  UA,
  extractGoLiveImageUrl,
  proxyImagePathForId,
  fetchEventListAxios,
  fetchEventListPlaywright,
  fetchGoLiveEventList,
  loadGoLiveImageMap,
  saveGoLiveImageMap,
  resolveGoLiveImageUrl,
};
