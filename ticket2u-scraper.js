'use strict';

/**
 * Ticket2U Malaysia — public event listing via /api/api2.ashx (method: eventlisting).
 * Same output shape as eventbrite-scraper: id, title, url, date, time, venue, city,
 * image, isFree, price, category, summary.
 *
 * Optional: set TICKET2U_KEYWORD (e.g. "Kuala Lumpur") to narrow results; default is
 * all listings (no keyword filter).
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const BASE = 'https://www.ticket2u.com.my';
const API_URL = `${BASE}/api/api2.ashx`;
const REFERER = `${BASE}/event/list`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUTPUT = path.join(__dirname, 'data', 'ticket2u-events.json');

function buildFilter(page) {
  return {
    currentpage: page,
    kw: process.env.TICKET2U_KEYWORD || '',
    cc: process.env.TICKET2U_CAT || '',
    scc: process.env.TICKET2U_SUBCAT || '',
    stateid: process.env.TICKET2U_STATE_ID || '',
    areaid: process.env.TICKET2U_AREA_ID || '',
    ex: process.env.TICKET2U_INCLUDE_EXPIRED === '1',
    sort: process.env.TICKET2U_SORT || '',
  };
}

function absoluteUrl(link) {
  if (!link) return '';
  if (/^https?:\/\//i.test(link)) return link;
  return `${BASE}${link.startsWith('/') ? '' : '/'}${link}`;
}

function parseDateIso(row) {
  if (row.datefrom) {
    const d = String(row.datefrom);
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return (row.datefrom106 || '').trim();
}

function normalizeRow(row) {
  const id = String(row.id || '').trim();
  if (!id) return null;

  const pf = parseFloat(String(row.pricefrom || '').replace(/,/g, ''));
  const isFree =
    row.pricefrom == null ||
    row.pricefrom === '' ||
    (Number.isFinite(pf) && pf === 0);

  let price = '';
  if (isFree) price = 'Free';
  else if (row.pricefrom != null && row.pricefrom !== '')
    price = `${row.pricefrom} ${row.basecurrency || 'RM'}`.trim();

  return {
    id,
    title: row.titlename || row.name || 'Untitled',
    url: absoluteUrl(row.link),
    date: parseDateIso(row),
    time: (row.time || '').trim(),
    venue: (row.locname || '').trim() || 'TBA',
    city: (row.statename || '').trim(),
    image: (row.avatar || '').trim(),
    isFree,
    price,
    category: (row.eventcat || '').trim(),
    summary: (row.excerpt || '').toString().slice(0, 4000),
  };
}

async function postEventListing(page) {
  const { data } = await axios.post(
    API_URL,
    { method: 'eventlisting', data: buildFilter(page) },
    {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Referer: REFERER,
        Origin: BASE,
      },
      timeout: 60000,
    }
  );

  if (data.haserror) {
    const msg = data.message || 'Unknown API error';
    throw new Error(`Ticket2U API: ${msg}`);
  }

  return data;
}

async function scrapeTicket2U() {
  console.log('📡 Ticket2U — api2.ashx eventlisting (paginated)');
  if (process.env.TICKET2U_KEYWORD)
    console.log(`   Keyword filter: "${process.env.TICKET2U_KEYWORD}"`);

  const byId = new Map();
  let page = 1;
  let rowtotal = null;
  let rowpp = null;

  while (true) {
    console.log(`   Page ${page}…`);

    const payload = await postEventListing(page);
    const chunks = Array.isArray(payload.data) ? payload.data : [];

    const rows = [];
    for (const item of chunks) {
      if (item && item.row && item.row.id) rows.push(item.row);
    }

    if (!rows.length) {
      console.log('      (no rows)');
      break;
    }

    rowtotal = parseInt(String(rows[0].rowtotal || '0'), 10) || rowtotal;
    rowpp = parseInt(String(rows[0].rowpp || '0'), 10) || rowpp;

    for (const row of rows) {
      const ev = normalizeRow(row);
      if (ev) byId.set(ev.id, ev);
    }

    console.log(
      `      +${rows.length} events (unique total: ${byId.size})  rowtotal=${rowtotal} rowpp=${rowpp}`
    );

    const maxPage =
      rowtotal && rowpp ? Math.max(1, Math.ceil(rowtotal / rowpp)) : page;
    if (page >= maxPage) break;

    page += 1;
  }

  const events = Array.from(byId.values());
  await fs.ensureDir(path.join(__dirname, 'data'));
  await fs.writeJson(OUTPUT, events, { spaces: 2 });

  console.log(`\n💾 Saved ${events.length} events → ${OUTPUT}`);
  return events;
}

if (require.main === module) {
  scrapeTicket2U().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scrapeTicket2U };
