'use strict';

/**
 * GoLive Asia events via advisoryapps API (+ Playwright fallback).
 * Output shape matches existing scrapers:
 * id, title, url, date, time, venue, city, image, isFree, price, category, summary
 *
 * Images: API returns expiring S3 presigned URLs. We save a fresh map in
 * data/goliveasia-image-map.json and expose stable paths via /api/golive-image/:id
 */

const fs = require('fs-extra');
const path = require('path');
const {
  BASE_WEB,
  extractGoLiveImageUrl,
  proxyImagePathForId,
  fetchGoLiveEventList,
  loadGoLiveImageMap,
  saveGoLiveImageMap,
  refreshGoLiveImageMapViaDetailPages,
} = require('./golive-image-helpers');

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

function normalizeEvent(row, imageMap) {
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

  const directImage = extractGoLiveImageUrl(row);
  if (directImage) imageMap[id] = directImage;

  return {
    id,
    title: row.name || 'Untitled',
    url: `${BASE_WEB}/event-detail/${id}`,
    date: dateObj && !Number.isNaN(dateObj.valueOf()) ? dateObj.toISOString().slice(0, 10) : '',
    time: dateObj && !Number.isNaN(dateObj.valueOf()) ? dateObj.toISOString().slice(11, 16) : '',
    venue: row.Venue?.name || 'TBA',
    city: row.Venue?.city || '',
    image: proxyImagePathForId(id),
    isFree,
    price,
    category: pickCategory(row),
    summary: htmlToText(row.general_information),
  };
}

async function scrapeGoLiveAsia() {
  console.log('📡 GoLive Asia — loading event list…');

  let existing = [];
  if (await fs.pathExists(OUTPUT)) {
    try {
      existing = await fs.readJson(OUTPUT);
      if (!Array.isArray(existing)) existing = [];
    } catch (_) {
      existing = [];
    }
  }

  let rows = [];
  let source = 'none';
  try {
    const loaded = await fetchGoLiveEventList();
    rows = loaded.rows;
    source = loaded.source;
  } catch (err) {
    console.warn('GoLive list:', err.message);
  }

  console.log(`   Loaded ${rows.length} rows (${source})`);

  const imageMap = await loadGoLiveImageMap();
  for (const row of rows) {
    const direct = extractGoLiveImageUrl(row);
    if (direct && row.id != null) imageMap[String(row.id)] = direct;
  }

  const minExpected = existing.length ? Math.max(3, Math.floor(existing.length * 0.5)) : 3;
  const useFullReplace = rows.length >= minExpected || !existing.length;

  let eventsOut = existing;

  if (!useFullReplace) {
    console.warn(
      `   Keeping ${existing.length} saved events (API/DOM only returned ${rows.length}; avoiding data loss).`,
    );
    eventsOut = existing;
  } else {

    const byId = new Map();
    for (const row of rows) {
      const ev = normalizeEvent(row, imageMap);
      if (ev) byId.set(ev.id, ev);
    }
    eventsOut = Array.from(byId.values());
    await fs.ensureDir(path.join(__dirname, 'data'));
    await fs.writeJson(OUTPUT, eventsOut, { spaces: 2 });
  }

  const finalMap = await refreshGoLiveImageMapViaDetailPages(
    eventsOut.map((e) => e.id),
    imageMap,
  );
  await saveGoLiveImageMap(finalMap);

  const withImages = eventsOut.filter((e) => finalMap[e.id]).length;
  console.log(
    `🖼  Image URLs ready: ${withImages}/${eventsOut.length} → data/goliveasia-image-map.json`,
  );
  console.log(`💾 GoLive Asia: ${eventsOut.length} events in ${OUTPUT}`);
  return eventsOut;
}

if (require.main === module) {
  scrapeGoLiveAsia().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scrapeGoLiveAsia };
