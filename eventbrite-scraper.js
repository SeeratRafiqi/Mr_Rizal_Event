'use strict';

/**
 * Eventbrite Kuala Lumpur discovery via internal /api/v3/destination/search/
 *
 * The public site uses POST with a JSON body (browse_surface + event_search).
 * Plain GET to this path returns 405. Pagination is driven by event_search.page
 * and optional pagination.continuation tokens; we mirror the requested query
 * params (client_continuation, page_size, place.address.city, expand) on each POST.
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const SEARCH_URL = 'https://www.eventbrite.com/api/v3/destination/search/';
const REFERER =
  'https://www.eventbrite.com/d/malaysia--kuala-lumpur/events/';
const PLACE_ID_KL = '102023407';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUTPUT = path.join(__dirname, 'data', 'eventbrite-events.json');

function pickCategory(ev) {
  const tags = ev.tags || [];
  const cat = tags.find(
    (t) =>
      t.prefix === 'EventbriteCategory' ||
      (t.tag && String(t.tag).startsWith('EventbriteCategory/'))
  );
  return cat?.display_name || cat?.localized?.display_name || '';
}

function normalizeEvent(ev) {
  const id = String(ev.id || '').trim();
  if (!id) return null;

  const isFree = Boolean(ev.ticket_availability?.is_free);
  let price = ev.ticket_availability?.minimum_ticket_price?.display || '';
  if (!price && isFree) price = 'Free';

  const venueName =
    typeof ev.primary_venue?.name === 'string'
      ? ev.primary_venue.name
      : ev.primary_venue?.name?.text || '';

  return {
    id,
    title: ev.name || 'No title',
    url: ev.url || '',
    date: ev.start_date || '',
    time: ev.start_time || '',
    venue: venueName || 'Online',
    city: ev.primary_venue?.address?.city || '',
    image:
      ev.image?.original?.url ||
      ev.image?.url ||
      '',
    isFree,
    price: price || '',
    category: pickCategory(ev),
    summary: (ev.summary || '').toString().slice(0, 4000),
  };
}

async function createSessionHeaders() {
  const warmup = await axios.get(REFERER, {
    headers: { 'User-Agent': UA },
    maxRedirects: 5,
  });
  const setCookie = warmup.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const csrftoken = cookie
    .split('; ')
    .find((p) => p.startsWith('csrftoken='))
    ?.split('=')[1];

  return {
    'User-Agent': UA,
    Accept: 'application/json',
    Referer: REFERER,
    Origin: 'https://www.eventbrite.com',
    'Content-Type': 'application/json',
    Cookie: cookie,
    'X-CSRFToken': csrftoken,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function buildSearchBody(page) {
  return {
    browse_surface: 'search',
    event_search: {
      places: [PLACE_ID_KL],
      online_events_only: false,
      dates: ['current_future'],
      sort: 'quality',
      aggs: {
        organizertagsautocomplete_agg: { size: 50 },
        tags: {},
        dates: {},
      },
      page,
    },
    'expand.destination_event': [
      'primary_venue',
      'image',
      'ticket_availability',
      'saves',
      'event_sales_status',
      'primary_organizer',
    ],
  };
}

function searchQueryParams(clientContinuation) {
  return {
    client_continuation: clientContinuation || '',
    page_size: 50,
    'place.address.city': 'Kuala Lumpur',
    expand: 'event_description,event_ticket_availability',
  };
}

async function scrapeEventbrite() {
  console.log('📡 Eventbrite KL — axios /destination/search/ (paginated)');

  const headers = await createSessionHeaders();
  const byId = new Map();

  let page = 1;
  let continuation = '';

  while (true) {
    console.log(`   Page ${page}…`);

    const body = buildSearchBody(page);
    const { data } = await axios.post(SEARCH_URL, body, {
      headers,
      params: searchQueryParams(continuation),
    });

    const results = data.events?.results || [];
    const pagination = data.events?.pagination;

    for (const ev of results) {
      const row = normalizeEvent(ev);
      if (row) byId.set(row.id, row);
    }

    console.log(
      `      +${results.length} events (unique total: ${byId.size})  continuation: ${
        pagination?.continuation ? 'yes' : 'no'
      }`
    );

    continuation = pagination?.continuation || '';

    if (!results.length) break;
    if (!continuation) break;

    page += 1;
  }

  const events = Array.from(byId.values());
  await fs.ensureDir(path.join(__dirname, 'data'));
  await fs.writeJson(OUTPUT, events, { spaces: 2 });

  console.log(`\n💾 Saved ${events.length} events → ${OUTPUT}`);
  return events;
}

if (require.main === module) {
  scrapeEventbrite().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scrapeEventbrite };
