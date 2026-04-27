require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { HfInference } = require('@huggingface/inference');

// FIX: lazy-init Supabase so a missing SUPABASE_URL doesn't crash the server at
// startup — the /api/chat route already guards for missing credentials.
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  _supabase = createClient(url, key);
  return _supabase;
}
// Keep a top-level `supabase` reference for the chat-history helper (non-critical path)
Object.defineProperty(global, 'supabase', { get: getSupabase, configurable: true });

const hf = process.env.HUGGINGFACE_API_KEY
  ? new HfInference(process.env.HUGGINGFACE_API_KEY)
  : null;

const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const {
  parseUserIntent,
  filterEventsByPreferences,
  buildIntentContext,
  isRefinementQuery,
  isEventFree,
  todayISO,
  dedupeEventsForRecommendations,
  diversifyBySource,
  filterFutureEvents,
  mergeRagPoolForSourceDiversity,
  poolNeedsSourceBlend,
  selectDiverseRecommendations,
} = require('./chatbot-utils');

const app = express();
const PORT = Number(process.env.PORT) || 3040;

const HF_EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';

const RAG_SYSTEM_PROMPT = `You are a warm, fun, friendly friend helping someone discover events in Malaysia.
- Sound human: short-ish, punchy, natural emojis — not robotic or salesy.
- You only ever recommend from the event list the user message includes (JSON). Never invent venues, dates, or prices.
- If the event list is empty, say you could not find matches and set show_events to false.
- Only recommend UPCOMING events (date is today or later). Never hype or feature events whose dates are before today unless the user clearly asked about the past or a specific past day.
- If every event in the JSON is in the past and the user did not ask about past events, say there are no good upcoming matches and set show_events to false.
- This app does not sell tickets — point people to the event link on the source site for booking.
- Reply must be ONLY one JSON object, no markdown code fences, no text before or after:
{"reply":"<warm recommendation>","show_events":true|false}
show_events: true only when you are actually recommending specific events from the list.`;

const CASUAL_SYSTEM_PROMPT = `You are a warm, friendly assistant for discovering events in Malaysia.
The user is only greeting you or making small talk — they did NOT ask to see event listings or recommendations yet.
Reply in one short message (light emoji ok). Do NOT list events, venues, dates, or prices.
Reply must be ONLY one JSON object:
{"reply":"<message>","show_events":false}`;

const SUPABASE_TABLE_PAGE = Math.max(1, Number(process.env.SUPABASE_PAGE_SIZE) || 1000);

app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer.html'));
});

app.get('/chatbot', (req, res) => {
  res.sendFile(path.join(__dirname, 'chatbot.html'));
});

function isRinggitOrFreeEvent(event) {
  if (event?.isFree) return true;
  const price = String(event?.price || '').toUpperCase();
  if (!price) return true;
  return price.includes('RM') || price.includes('MYR');
}

let goliveListCache = { at: 0, rows: [] };
const GOLIVE_CACHE_MS = 30 * 60 * 1000;

async function fetchGoLiveEventRows() {
  const now = Date.now();
  if (now - goliveListCache.at < GOLIVE_CACHE_MS && goliveListCache.rows.length) {
    return goliveListCache.rows;
  }
  const { data } = await axios.get('https://golive-production.advisoryapps.com/api/event/list', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: 'https://www.golive-asia.com/event-list',
      Origin: 'https://www.golive-asia.com',
    },
    timeout: 60000,
  });
  const rows = data?.result?.result;
  if (!Array.isArray(rows)) throw new Error('Unexpected GoLive API response');
  goliveListCache = { at: now, rows };
  return rows;
}

function rewriteGoLiveImageForClient(event) {
  const tag = event._source || event.source;
  if (tag !== 'goliveasia') return event;
  // If scraper already provided proxy image path, keep it.
  if (/\/api\/golive-image\/[^/?#]+/i.test(String(event.image || ''))) return event;
  const id = event.id;
  if (id == null || String(id).trim() === '') return event;
  const sid = encodeURIComponent(String(id));
  return { ...event, image: `/api/golive-image/${sid}` };
}

/** Merged scraped JSON — cached until any source file mtime changes (avoids parsing ~640KB+ every /api/events hit). */
const SCRAPED_EVENTS_FILES = [
  'data/eventbrite-events.json',
  'data/ticket2u-events.json',
  'data/goliveasia-events.json',
  'data/ticketmelon-events.json',
].map((rel) => path.join(__dirname, rel));

let scrapedEventsCache = { mtime: 0, list: null };

function maxFileMtimeMs(paths) {
  let max = 0;
  for (const p of paths) {
    try {
      if (fs.pathExistsSync(p)) {
        const t = fs.statSync(p).mtimeMs;
        if (t > max) max = t;
      }
    } catch {
      /* ignore */
    }
  }
  return max;
}

function getCachedMergedScrapedEvents() {
  const mtime = maxFileMtimeMs(SCRAPED_EVENTS_FILES);
  if (scrapedEventsCache.list && mtime > 0 && mtime === scrapedEventsCache.mtime) {
    return scrapedEventsCache.list;
  }

  const readList = (rel) => {
    const full = path.join(__dirname, rel);
    if (!fs.existsSync(full)) return [];
    return JSON.parse(fs.readFileSync(full, 'utf-8'));
  };

  const eventbrite = readList('data/eventbrite-events.json');
  const ticket2u = readList('data/ticket2u-events.json');
  const goliveasia = readList('data/goliveasia-events.json');
  const ticketmelon = readList('data/ticketmelon-events.json');

  const merged = [
    ...eventbrite.map((e) => ({ ...e, _source: 'eventbrite' })),
    ...ticket2u.map((e) => ({ ...e, _source: 'ticket2u' })),
    ...goliveasia.map((e) => ({ ...e, _source: 'goliveasia' })),
    ...ticketmelon.map((e) => ({ ...e, _source: 'ticketmelon' })),
  ].map(rewriteGoLiveImageForClient);

  scrapedEventsCache = { mtime, list: merged };
  return merged;
}

function meanPoolTokens(tokenMatrix) {
  if (!tokenMatrix.length) return [];
  const dim = tokenMatrix[0].length;
  const out = new Array(dim).fill(0);
  for (let t = 0; t < tokenMatrix.length; t += 1) {
    const row = tokenMatrix[t];
    for (let d = 0; d < dim; d += 1) out[d] += row[d];
  }
  for (let d = 0; d < dim; d += 1) out[d] /= tokenMatrix.length;
  return out;
}

/** Normalize HF feature-extraction output to a list of embedding vectors. */
function parseFeatureExtractionOutput(data) {
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected HF embedding shape: ${typeof data}`);
  }
  if (data.length === 0) return [];
  const first = data[0];
  if (Array.isArray(first) && first.length && Array.isArray(first[0]) && typeof first[0][0] === 'number') {
    return data.map((seq) => meanPoolTokens(seq));
  }
  if (Array.isArray(first) && typeof first[0] === 'number') {
    return data.map((row) => {
      if (!Array.isArray(row) || typeof row[0] !== 'number') {
        throw new Error('Mixed batch embedding shape');
      }
      return row;
    });
  }
  if (typeof first === 'number') {
    return [data];
  }
  throw new Error('Could not parse embedding from Hugging Face');
}

async function embedUserQuery(text) {
  if (!hf) throw new Error('HUGGINGFACE_API_KEY not configured');
  const raw = await hf.featureExtraction({
    model: HF_EMBEDDING_MODEL,
    inputs: String(text).slice(0, 2000),
  });
  const vectors = parseFeatureExtractionOutput(raw);
  if (!vectors.length) throw new Error('Empty embedding from Hugging Face');
  return vectors[0];
}

function parseLlmJson(text) {
  const t = String(text || '').trim();
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let p = tryParse(t);
  if (p && typeof p === 'object') return p;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    p = tryParse(fence[1].trim());
    if (p) return p;
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    p = tryParse(t.slice(start, end + 1));
    if (p) return p;
  }
  return null;
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksMalaysiaEvent(e) {
  const source = String(e?._source || e?.source || '').toLowerCase();
  if (source === 'ticket2u' || source === 'goliveasia' || source === 'ticketmelon') return true;
  const blob = `${e?.title || ''} ${e?.venue || ''} ${e?.city || ''} ${e?.url || ''}`.toLowerCase();
  return /\b(malaysia|kuala lumpur|\bkl\b|selangor|penang|johor|putrajaya|sarawak|sabah|melaka|malacca|cyberjaya|petaling)\b/.test(
    blob,
  );
}

function getItineraryEventPool() {
  const merged = getCachedMergedScrapedEvents();
  const future = filterFutureEvents(merged);
  const onlyMy = future.filter(looksMalaysiaEvent);
  return dedupeEventsForRecommendations(onlyMy).slice(0, 2000);
}

function eventOptionFromRow(e) {
  const source = e._source || e.source || 'unknown';
  const safeId = `${source}:${e.id != null ? String(e.id) : normalizeText(e.title).slice(0, 50)}`;
  return {
    key: safeId,
    id: e.id != null ? String(e.id) : '',
    source,
    title: e.title || 'Untitled Event',
    date: e.date || '',
    venue: e.venue || '',
    city: e.city || '',
    url: e.url || '',
    image: e.image || '',
  };
}

function findEventForItinerary(pool, body) {
  const eventKey = String(body?.eventKey || '').trim();
  const eventId = String(body?.eventId || '').trim();
  const source = String(body?.source || '').trim().toLowerCase();
  const title = String(body?.eventTitle || '').trim();

  if (eventKey) {
    const m = pool.find((e) => `${e._source || e.source}:${String(e.id || '')}` === eventKey);
    if (m) return m;
  }
  if (eventId) {
    const m = pool.find((e) => String(e.id || '') === eventId && (!source || String(e._source || e.source).toLowerCase() === source));
    if (m) return m;
  }
  if (title) {
    const q = normalizeText(title);
    let m = pool.find((e) => normalizeText(e.title) === q);
    if (m) return m;
    m = pool.find((e) => normalizeText(e.title).includes(q) || q.includes(normalizeText(e.title)));
    if (m) return m;
  }
  return null;
}

async function generateItineraryWithDashScope(payload) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY not configured');
  const base = process.env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  const model = process.env.DASHSCOPE_MODEL || 'qwen-plus';
  const url = `${base.replace(/\/$/, '')}/chat/completions`;

  const systemPrompt = [
    'You are an expert Malaysia travel planner.',
    'Build practical itinerary suggestions around one selected event.',
    'Country MUST be Malaysia only.',
    'Do not suggest non-Malaysia cities/countries.',
    'Return ONLY JSON.',
    'JSON schema:',
    '{',
    '  "summary": "short paragraph",',
    '  "event_context": {"title":"","date":"","venue":"","city":""},',
    '  "days":[{"day":1,"theme":"","places":[{"name":"","time":"","description":"","fun_fact":"","map_query":"","image_query":""}]}],',
    '  "hotels":[{"name":"","area":"","why":"","booking_url":""}],',
    '  "flights":[{"route":"","notes":"","booking_url":""}]',
    '}',
    'For booking_url use generic, safe links only (Google Flights/Hotels or Booking search links).',
  ].join('\n');

  const userBlock = JSON.stringify(payload);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userBlock },
      ],
      max_tokens: 1400,
      temperature: 0.5,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errMsg = data.error?.message || data.message || data.code || `DashScope error (${response.status})`;
    throw new Error(errMsg);
  }
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty itinerary response from DashScope');
  const parsed = parseLlmJson(String(text));
  if (parsed && typeof parsed === 'object') return parsed;

  // Repair pass: ask model to output strict JSON only.
  const repairPrompt = [
    'Convert this into strict valid JSON only (no markdown).',
    'Keep Malaysia-only places/cities.',
    'Required keys: summary, event_context, days, hotels, flights.',
    String(text),
  ].join('\n');
  const repairResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No commentary.' },
        { role: 'user', content: repairPrompt },
      ],
      max_tokens: 1200,
      temperature: 0.1,
    }),
  });
  const repairData = await repairResponse.json().catch(() => ({}));
  if (repairResponse.ok) {
    const repaired = parseLlmJson(String(repairData.choices?.[0]?.message?.content || ''));
    if (repaired && typeof repaired === 'object') return repaired;
  }
  throw new Error('Could not parse itinerary JSON');
}

const MALAYSIA_GUIDE_PLACES = {
  'kuala lumpur': [
    { name: 'Petronas Twin Towers & KLCC Park', tags: ['balanced', 'culture', 'chill'], best_time: 'Morning', ticket_info: 'Skybridge/Observation Deck ticket required', map_query: 'Petronas Twin Towers Kuala Lumpur', image_query: 'Petronas Twin Towers Kuala Lumpur', description: 'Start with the city icon, then walk KLCC Park for skyline views.', fun_fact: 'The twin towers were the world’s tallest buildings from 1998 to 2004.' },
    { name: 'Bukit Bintang & Jalan Alor Food Street', tags: ['foodie', 'balanced', 'night'], best_time: 'Evening', ticket_info: 'No entry fee', map_query: 'Jalan Alor Kuala Lumpur', image_query: 'Jalan Alor food street', description: 'Street food trail and shopping district with nightlife energy.', fun_fact: 'Jalan Alor is one of Kuala Lumpur’s best-known late-night food streets.' },
    { name: 'Batu Caves', tags: ['culture', 'adventurous'], best_time: 'Morning', ticket_info: 'Cave temples are generally free; some attractions paid', map_query: 'Batu Caves Selangor', image_query: 'Batu Caves golden statue', description: 'Temple cave complex with steep stairs and panoramic viewpoints.', fun_fact: 'The colorful staircase has 272 steps to the main cave temple.' },
    { name: 'KL Forest Eco Park Canopy Walk', tags: ['adventurous', 'chill'], best_time: 'Morning', ticket_info: 'Small entrance fee may apply', map_query: 'KL Forest Eco Park canopy walk', image_query: 'KL Forest Eco Park canopy walk', description: 'Urban rainforest trail near city center for easy nature immersion.', fun_fact: 'It is one of the oldest permanent forest reserves in Malaysia.' },
    { name: 'Merdeka Square & Sultan Abdul Samad Building', tags: ['culture', 'balanced'], best_time: 'Afternoon', ticket_info: 'Public area, free', map_query: 'Merdeka Square Kuala Lumpur', image_query: 'Merdeka Square Kuala Lumpur', description: 'Historic core of Kuala Lumpur with colonial-era architecture.', fun_fact: 'Malaysia’s independence flag-raising took place at Merdeka Square in 1957.' },
  ],
  penang: [
    { name: 'George Town Street Art Trail', tags: ['culture', 'foodie', 'balanced'], best_time: 'Morning', ticket_info: 'Public streets, free', map_query: 'George Town street art Penang', image_query: 'George Town street art murals', description: 'Walk through UNESCO streets, murals, and heritage shophouses.', fun_fact: 'George Town is a UNESCO World Heritage Site known for its living culture.' },
    { name: 'Penang Hill & The Habitat', tags: ['chill', 'adventurous'], best_time: 'Morning', ticket_info: 'Funicular + attraction tickets', map_query: 'Penang Hill The Habitat', image_query: 'Penang Hill view', description: 'Cooler hilltop air, rainforest views, and canopy experiences.', fun_fact: 'Penang Hill funicular has served visitors for over a century.' },
    { name: 'Chew Jetty', tags: ['culture', 'chill'], best_time: 'Sunset', ticket_info: 'Free', map_query: 'Chew Jetty Penang', image_query: 'Chew Jetty sunset', description: 'Clan jetty village over water with photogenic boardwalks.', fun_fact: 'The jetties were historically home to Chinese clan communities.' },
    { name: 'Penang Food Trail (Gurney / Chulia)', tags: ['foodie', 'night'], best_time: 'Evening', ticket_info: 'Pay per food item', map_query: 'Gurney Drive hawker centre', image_query: 'Penang hawker food', description: 'Try assam laksa, char kway teow, and local desserts.', fun_fact: 'Penang is often called Malaysia’s food capital.' },
  ],
  johor: [
    { name: 'Johor Bahru Heritage Walk', tags: ['culture', 'balanced'], best_time: 'Morning', ticket_info: 'Mostly free', map_query: 'Johor Bahru old town heritage walk', image_query: 'Johor Bahru old town', description: 'Explore old quarters, murals, and cultural landmarks.', fun_fact: 'Johor Bahru sits at the southern gateway of Peninsular Malaysia.' },
    { name: 'Danga Bay Waterfront', tags: ['chill', 'night'], best_time: 'Evening', ticket_info: 'Free public area', map_query: 'Danga Bay Johor Bahru', image_query: 'Danga Bay waterfront', description: 'Waterfront promenade for sunset and casual dining.', fun_fact: 'Danga Bay is one of the largest recreational waterfronts in Johor.' },
    { name: 'Desaru Coast Adventure', tags: ['adventurous', 'chill'], best_time: 'Day trip', ticket_info: 'Varies by attraction', map_query: 'Desaru Coast Johor', image_query: 'Desaru Coast beach', description: 'Beachside escape with water and resort activities.', fun_fact: 'Desaru coastline stretches across scenic east Johor shores.' },
  ],
  melaka: [
    { name: 'Jonker Street Night Market', tags: ['foodie', 'culture', 'night'], best_time: 'Evening', ticket_info: 'Free entry', map_query: 'Jonker Street Melaka', image_query: 'Jonker Street night market', description: 'Night market for snacks, souvenirs, and heritage vibes.', fun_fact: 'Melaka’s historic center is recognized as a UNESCO site.' },
    { name: 'A Famosa & Stadthuys Area', tags: ['culture', 'balanced'], best_time: 'Morning', ticket_info: 'Mostly free / museum tickets optional', map_query: 'A Famosa Melaka', image_query: 'A Famosa Melaka', description: 'Core colonial landmarks telling Melaka’s maritime past.', fun_fact: 'A Famosa is one of the oldest surviving European structures in Asia.' },
    { name: 'Melaka River Cruise', tags: ['chill', 'night'], best_time: 'Sunset/Evening', ticket_info: 'Cruise ticket required', map_query: 'Melaka River Cruise', image_query: 'Melaka river cruise', description: 'Boat route through murals, bridges, and lit riverside scenes.', fun_fact: 'The river was once a major trading artery of the Melaka Sultanate.' },
  ],
  'kota kinabalu': [
    { name: 'Tanjung Aru Beach Sunset', tags: ['chill', 'night'], best_time: 'Sunset', ticket_info: 'Free', map_query: 'Tanjung Aru Beach Kota Kinabalu', image_query: 'Tanjung Aru sunset', description: 'Iconic Sabah sunset point with food stalls nearby.', fun_fact: 'Tanjung Aru sunsets are often ranked among Malaysia’s best.' },
    { name: 'Kota Kinabalu Waterfront', tags: ['foodie', 'night', 'balanced'], best_time: 'Evening', ticket_info: 'Free public area', map_query: 'Kota Kinabalu Waterfront', image_query: 'Kota Kinabalu Waterfront', description: 'Dining, sea views, and live atmosphere in city center.', fun_fact: 'The waterfront is a social hub for locals and travelers alike.' },
    { name: 'Kinabalu Park Day Trip', tags: ['adventurous', 'culture'], best_time: 'Day trip', ticket_info: 'Park entrance fee', map_query: 'Kinabalu Park Sabah', image_query: 'Mount Kinabalu park', description: 'Highland nature trails and botanical biodiversity.', fun_fact: 'Kinabalu Park is Malaysia’s first UNESCO World Heritage Site.' },
  ],
  kuching: [
    { name: 'Kuching Waterfront', tags: ['chill', 'culture', 'night'], best_time: 'Evening', ticket_info: 'Free', map_query: 'Kuching Waterfront', image_query: 'Kuching waterfront sunset', description: 'Scenic river promenade with landmarks and performers.', fun_fact: 'Kuching means “cat” in Malay, reflected in city mascots and monuments.' },
    { name: 'Sarawak Cultural Village', tags: ['culture', 'balanced'], best_time: 'Morning', ticket_info: 'Entrance ticket', map_query: 'Sarawak Cultural Village', image_query: 'Sarawak Cultural Village', description: 'Interactive living museum of Sarawak ethnic heritage.', fun_fact: 'The village showcases traditional houses from major Sarawak communities.' },
    { name: 'Bako National Park', tags: ['adventurous', 'nature'], best_time: 'Day trip', ticket_info: 'Park + boat transfer fees', map_query: 'Bako National Park', image_query: 'Bako National Park proboscis monkey', description: 'Mangrove and coastal trails with wildlife spotting.', fun_fact: 'Bako is one of the best places to spot proboscis monkeys in the wild.' },
  ],
};

function detectMalaysiaCityHint(event) {
  const blob = normalizeText(`${event?.city || ''} ${event?.venue || ''} ${event?.title || ''}`);
  if (blob.includes('kota kinabalu')) return 'kota kinabalu';
  if (blob.includes('kuching')) return 'kuching';
  if (blob.includes('melaka') || blob.includes('malacca')) return 'melaka';
  if (blob.includes('johor') || blob.includes('johor bahru')) return 'johor';
  if (blob.includes('penang') || blob.includes('george town')) return 'penang';
  if (blob.includes('kuala lumpur') || blob.includes('selangor') || blob.includes('petaling') || blob.includes('kl')) return 'kuala lumpur';
  return 'kuala lumpur';
}

function pickPlacesForPreference(allPlaces, travelStyle, adventureLevel) {
  const style = String(travelStyle || 'balanced').toLowerCase();
  const adv = String(adventureLevel || 'medium').toLowerCase();
  const score = (p) => {
    let s = 0;
    const tags = Array.isArray(p.tags) ? p.tags : [];
    if (tags.includes(style)) s += 4;
    if (style === 'balanced') s += 2;
    if (adv === 'high' && tags.includes('adventurous')) s += 4;
    if (adv === 'low' && (tags.includes('chill') || tags.includes('culture'))) s += 3;
    if (adv === 'medium' && (tags.includes('balanced') || tags.includes('culture'))) s += 2;
    return s;
  };
  return [...allPlaces].sort((a, b) => score(b) - score(a));
}

function buildFallbackItinerary(event, prefs) {
  const cityKey = detectMalaysiaCityHint(event);
  const cityPlaces = MALAYSIA_GUIDE_PLACES[cityKey] || MALAYSIA_GUIDE_PLACES['kuala lumpur'];
  const style = String(prefs?.travelStyle || 'balanced');
  const adventure = String(prefs?.adventureLevel || 'medium');
  const days = Math.min(5, Math.max(1, Number(prefs?.days) || 2));
  const ranked = pickPlacesForPreference(cityPlaces, style, adventure);

  const dayEntries = [];
  for (let i = 1; i <= days; i += 1) {
    const p1 = ranked[(i - 1) % ranked.length];
    const p2 = ranked[(i + 1) % ranked.length];
    const p3 = ranked[(i + 2) % ranked.length];
    dayEntries.push({
      day: i,
      theme: i === 1 ? 'Arrival, Orientation & Event' : `Discover ${cityKey.toUpperCase()} Like a Local`,
      route_map_url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(event.venue || event.city || cityKey + ' malaysia')}&travelmode=driving`,
      places: [
        {
          ...p1,
          time: '09:30',
          estimated_duration: '1.5-2h',
          journal_prompt: `What surprised you most about ${p1.name}?`,
        },
        {
          ...p2,
          time: '13:30',
          estimated_duration: '2-3h',
          journal_prompt: `Describe one local interaction or food memory from ${p2.name}.`,
        },
        {
          name: i === 1 ? (event.title || 'Event Night') : p3.name,
          time: '19:00',
          description:
            i === 1
              ? `Attend ${event.title || 'your event'} at ${event.venue || event.city || 'the venue'} and plan dinner nearby.`
              : p3.description,
          fun_fact:
            i === 1
              ? 'Event venues in Malaysia are often close to dining and transit hubs.'
              : p3.fun_fact,
          map_query: i === 1 ? `${event.venue || event.city || cityKey} malaysia` : p3.map_query,
          image_query: i === 1 ? `${event.title || cityKey} malaysia event` : p3.image_query,
          best_time: i === 1 ? 'Evening' : p3.best_time,
          ticket_info: i === 1 ? 'Event ticket required' : p3.ticket_info,
          estimated_duration: i === 1 ? '3-4h' : '2h',
          journal_prompt:
            i === 1
              ? 'What was the highlight of tonight’s event experience?'
              : `What would you recommend to another traveler about ${p3.name}?`,
        },
      ],
    });
  }

  const cityLabel = cityKey
    .split(' ')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');

  return {
    summary: `Detailed Malaysia guide itinerary for ${cityLabel}, centered around "${event.title}". Includes map-friendly stops, practical tips, and journal prompts for each day.`,
    event_context: {
      title: event.title || '',
      date: event.date || '',
      venue: event.venue || '',
      city: event.city || cityLabel,
    },
    days: dayEntries,
    journal: {
      mood_check: ['Energy level this morning?', 'Top memory of the day?', 'What to adjust tomorrow?'],
      packing_notes: ['Hydration + umbrella', 'Comfortable shoes', 'Power bank', 'Light rain layer'],
      prompts: dayEntries.flatMap((d) => (d.places || []).map((p) => p.journal_prompt).filter(Boolean)),
    },
    hotels: [
      {
        name: `${cityLabel} Transit-Friendly Stay`,
        area: cityLabel,
        why: 'Near event + food + transport, ideal for short city itineraries.',
        booking_url: `https://www.google.com/travel/hotels/${encodeURIComponent(`${cityLabel} Malaysia`)}`,
      },
      {
        name: `${cityLabel} Culture District Stay`,
        area: `${cityLabel} heritage / central area`,
        why: 'Best for walkable sightseeing and local dining.',
        booking_url: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(`${cityLabel} Malaysia`)}`,
      },
    ],
    flights: [
      {
        route: `Fly into ${cityLabel}, Malaysia`,
        notes: 'Compare flights arriving one day before event for lower stress.',
        booking_url: 'https://www.google.com/travel/flights',
      },
    ],
  };
}

function formatEventCard(event) {
  const withImg = rewriteGoLiveImageForClient({
    ...event,
    _source: event.source || event._source,
  });
  return {
    id: event.id || `${event.source}-${String(event.title || 'event').slice(0, 36)}`,
    title: event.title || 'Untitled Event',
    image: withImg.image || '',
    date: event.date || '',
    venue: event.venue || event.city || 'Unknown Venue',
    price: event.isFree ? 'Free' : (event.price || 'Paid'),
    source: event.source || 'unknown',
    url: event.url || '',
  };
}

function dbRowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    summary: row.description,
    venue: row.venue,
    city: row.city,
    date: row.date,
    price: row.price,
    image: row.image_url,
    url: row.event_url,
    source: row.source,
    category: row.category,
    isFree: row.is_free,
    _source: row.source,
  };
}

async function fetchAllEventsChatbotRows(supabase) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('events_chatbot')
      .select('id, title, description, venue, city, date, price, image_url, event_url, source, category, is_free')
      .range(offset, offset + SUPABASE_TABLE_PAGE - 1);
    if (error) throw new Error(`events_chatbot: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < SUPABASE_TABLE_PAGE) break;
    offset += SUPABASE_TABLE_PAGE;
  }
  return rows;
}

async function chatRagDashScope(userBlock, systemPrompt = RAG_SYSTEM_PROMPT) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY not configured');
  const base =
    process.env.DASHSCOPE_BASE_URL ||
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  const model = process.env.DASHSCOPE_MODEL || 'qwen-plus';
  const url = `${base.replace(/\/$/, '')}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userBlock },
      ],
      max_tokens: 1200,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errMsg =
      data.error?.message || data.message || data.code || `DashScope error (${response.status})`;
    throw new Error(errMsg);
  }
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from DashScope');
  return String(text).trim();
}

async function chatRagAnthropic(userBlock, systemPrompt = RAG_SYSTEM_PROMPT) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userBlock }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errMsg = data.error?.message || data.message || `Anthropic error (${response.status})`;
    throw new Error(errMsg);
  }
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Empty response from Anthropic');
  return String(text).trim();
}

async function generateRagRecommendation(message, history, slimEvents) {
  const hist = Array.isArray(history) ? history : [];
  const histText = hist
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content)
    .slice(-8)
    .map((h) => `${h.role}: ${String(h.content).slice(0, 1500)}`)
    .join('\n');

  const userBlock = [
    histText ? `Prior chat:\n${histText}\n` : '',
    `User question:\n${message}\n`,
    `Here are ${slimEvents.length} relevant events from Malaysia (JSON):\n${JSON.stringify(slimEvents)}\n`,
    `Generate a warm, friendly recommendation. Tell the user which events match their request and why.\n`,
    `Return ONLY JSON: {"reply":"...","show_events":true|false}`,
  ]
    .filter(Boolean)
    .join('\n');

  const hasDash = Boolean(process.env.DASHSCOPE_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  if (hasDash) {
    try {
      return await chatRagDashScope(userBlock);
    } catch (e) {
      if (hasAnthropic) return await chatRagAnthropic(userBlock);
      throw e;
    }
  }
  if (hasAnthropic) return await chatRagAnthropic(userBlock);
  throw new Error('Configure DASHSCOPE_API_KEY or ANTHROPIC_API_KEY for RAG replies');
}

async function generateCasualRecommendation(message, history) {
  const hist = Array.isArray(history) ? history : [];
  const histText = hist
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content)
    .slice(-8)
    .map((h) => `${h.role}: ${String(h.content).slice(0, 1500)}`)
    .join('\n');

  const userBlock = [
    histText ? `Prior chat:\n${histText}\n` : '',
    `Latest user message:\n${message}\n`,
    `Respond briefly. Invite them to ask for event ideas when ready (by date, city, vibe, or budget).`,
    `Return ONLY JSON: {"reply":"...","show_events":false}`,
  ]
    .filter(Boolean)
    .join('\n');

  const hasDash = Boolean(process.env.DASHSCOPE_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  if (hasDash) {
    try {
      return await chatRagDashScope(userBlock, CASUAL_SYSTEM_PROMPT);
    } catch (e) {
      if (hasAnthropic) return await chatRagAnthropic(userBlock, CASUAL_SYSTEM_PROMPT);
      throw e;
    }
  }
  if (hasAnthropic) return await chatRagAnthropic(userBlock, CASUAL_SYSTEM_PROMPT);
  throw new Error('Configure DASHSCOPE_API_KEY or ANTHROPIC_API_KEY for RAG replies');
}

async function saveChatHistory(userMessage, botReply) {
  try {
    const sb = getSupabase();
    if (!sb) return;
    const { error } = await sb.from('chat_history_chatbot').insert({
      user_message: userMessage,
      bot_reply: botReply,
      timestamp: new Date().toISOString(),
    });
    if (error) console.warn('[chat_history_chatbot]', error.message);
  } catch (e) {
    console.warn('[chat_history_chatbot]', e.message || e);
  }
}

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ reply: '', error: 'Missing message', events: [] });
  }

  const trimmed = message.trim();
  const latestIntent = parseUserIntent(trimmed);
  const intentContext = buildIntentContext(trimmed, history);
  const mergedIntent = parseUserIntent(intentContext);

  // Determine if the latest message is refining the previous query or starting fresh.
  // isRefinementQuery() uses explicit rules (see chatbot-utils.js) to decide:
  //   REFINE: "any under RM100?", "what about free ones?", "how about comedy?",
  //           "how about Saturday?" (continuation phrase + new date, no new place)
  //   NEW:    "are there events on Wednesday?", "events in KL", "show me concerts next month"
  const isRefinement = isRefinementQuery(trimmed, history);

  let intent;
  if (isRefinement) {
    // REFINEMENT — keep history date/place, overlay latest budget/mood/audience
    intent = {
      ...mergedIntent,
      budget: latestIntent.budget?.type !== 'any' || Number.isFinite(latestIntent.budget?.maxPrice)
        ? latestIntent.budget
        : mergedIntent.budget,
      mood: latestIntent.mood?.length > 0 ? latestIntent.mood : mergedIntent.mood,
      // For refinements that shift only the date (e.g. "how about Saturday?"), use latest date
      day: latestIntent.day?.type !== 'any' ? latestIntent.day : mergedIntent.day,
      audience: latestIntent.audience,
      isEventRequest: latestIntent.isEventRequest || mergedIntent.isEventRequest,
    };
  } else {
    // NEW QUERY — use the latest message as the full intent (ignore history context)
    intent = { ...latestIntent };
  }
  // Past mode only from the *current* message — never from older chat lines (prevents past events in "suggest something fun").
  intent.askingAboutPast = latestIntent.askingAboutPast === true;
  const hasExplicitFilter =
    intent.day?.type !== 'any' ||
    intent.place?.mode !== 'any' ||
    intent.budget?.type !== 'any' ||
    Number.isFinite(intent.budget?.maxPrice) ||
    (Array.isArray(intent.mood) && intent.mood.length > 0);

  const lowerTrim = trimmed.toLowerCase();
  const forceCasual =
    /^(hi|hey|hello|yo|sup|good\s+(morning|afternoon|evening))\b/i.test(trimmed) &&
    trimmed.length < 60 &&
    !/\b(event|events|shows?|recommend|tomorrow|today|tonight|weekend|next\s+week|ticket|concert|festival|gigs?|happening|what'?s\s+on)\b/i.test(
      lowerTrim,
    );

  if (!latestIntent.isEventRequest || forceCasual) {
    try {
      const rawLlm = await generateCasualRecommendation(trimmed, history);
      const parsed = parseLlmJson(rawLlm);
      const reply =
        parsed && typeof parsed.reply === 'string' && parsed.reply.trim()
          ? parsed.reply.trim()
          : 'Hey! 👋 When you want event ideas, tell me a day, city, vibe, or budget.';
      await saveChatHistory(trimmed, reply);
      return res.json({ reply, events: [] });
    } catch (err) {
      console.error('Casual chat error:', err.message);
      const reply =
        'Hey! 👋 When you\'re ready, ask for events — try a date, city, or "something fun this weekend".';
      await saveChatHistory(trimmed, reply);
      return res.json({ reply, events: [] });
    }
  }

  if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)) {
    return res.status(503).json({
      reply: 'Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to `.env`.',
      events: [],
    });
  }

  if (!hf) {
    return res.status(503).json({
      reply: 'Embeddings are not configured. Add HUGGINGFACE_API_KEY to `.env`.',
      events: [],
    });
  }

  try {
    const dateSpecific = intent.day?.dates?.length > 0;
    let selectedEvents = [];

    if (dateSpecific) {
      console.log('Date-specific request: scanning events_chatbot for exact date filter');
      const allRows = await fetchAllEventsChatbotRows(getSupabase());
      const allEvents = allRows.map(dbRowToEvent);
      selectedEvents = filterEventsByPreferences(allEvents, intent);
      console.log(`Date filter: ${selectedEvents.length} event(s)`);
    } else {
      console.log(`RAG search for: [${trimmed.slice(0, 120)}]`);

      let queryEmbedding;
      try {
        queryEmbedding = await embedUserQuery(trimmed);
      } catch (embErr) {
        console.error('Embedding error:', embErr.message);
        return res.status(502).json({
          reply: 'Could not embed your question right now — check Hugging Face API key and quota 🔑',
          events: [],
          error: embErr.message,
        });
      }

      const matchCount = hasExplicitFilter ? 100 : 60;
      const { data: matches, error: rpcErr } = await getSupabase().rpc('match_events_chatbot_rag', {
        query_embedding: queryEmbedding,
        match_count: matchCount,
      });

      if (rpcErr) {
        console.error('RAG rpc error:', rpcErr.message);
        if (rpcErr.message && rpcErr.message.includes('function') && rpcErr.message.includes('does not exist')) {
          return res.status(503).json({
            reply:
              'Vector search is not set up yet. Run `sql/match_events_chatbot_rag.sql` in the Supabase SQL editor (see ticket-scraper/sql folder).',
            events: [],
            error: rpcErr.message,
          });
        }
        if (rpcErr.message && rpcErr.message.includes('dimension')) {
          return res.status(503).json({
            reply:
              'Embedding dimension mismatch. Your DB function must use the same vector size as the model (384 for all-MiniLM-L6-v2).',
            events: [],
            error: rpcErr.message,
          });
        }
        return res.status(502).json({
          reply: 'Could not search events in the database right now 😢',
          events: [],
          error: rpcErr.message,
        });
      }

      const rows = Array.isArray(matches) ? matches : [];
      console.log(`Found ${rows.length} similar events`);

      let eventsForCards = rows.map(dbRowToEvent);
      if (!intent.askingAboutPast) {
        eventsForCards = filterFutureEvents(eventsForCards);
      }
      if (hasExplicitFilter) {
        selectedEvents = filterEventsByPreferences(eventsForCards, intent);
        if (selectedEvents.length === 0) {
          console.log('Vector + filter empty; full table scan');
          const allRows = await fetchAllEventsChatbotRows(getSupabase());
          let allEvents = allRows.map(dbRowToEvent);
          if (!intent.askingAboutPast) {
            allEvents = filterFutureEvents(allEvents);
          }
          selectedEvents = filterEventsByPreferences(allEvents, intent);
        }
      } else {
        let pool = dedupeEventsForRecommendations(eventsForCards);
        if (poolNeedsSourceBlend(pool)) {
          const allRows = await fetchAllEventsChatbotRows(getSupabase());
          const allDeduped = dedupeEventsForRecommendations(allRows.map(dbRowToEvent));
          const catalogSlice = intent.askingAboutPast ? allDeduped : filterFutureEvents(allDeduped);
          pool = mergeRagPoolForSourceDiversity(pool, catalogSlice, { maxPool: 85, floorPerSource: 4 });
        }
        selectedEvents = selectDiverseRecommendations(pool, intent, 15);
      }
      console.log(
        `Intent filter: ${hasExplicitFilter ? 'on' : 'off'}; selected ${selectedEvents.length} event(s)`,
      );
    }

    const slim = selectedEvents.map((r) => ({
      id: r.id,
      title: r.title,
      venue: r.venue,
      date: r.date,
      price: r.price,
      source: r.source,
      category: r.category,
    }));

    let rawLlm;
    try {
      rawLlm = await generateRagRecommendation(trimmed, history, slim);
    } catch (llmErr) {
      console.error('LLM error:', llmErr.message);
      const fallback =
        selectedEvents.length > 0
          ? `Here are ${selectedEvents.length} events that match what you asked — I could not run the AI writer just now (${llmErr.message}). Open any card for details! ✨`
          : `I could not reach the AI service (${llmErr.message}). Try again in a bit 🙏`;
      await saveChatHistory(trimmed, fallback);
      return res.json({
        reply: fallback,
        events: selectedEvents.length ? selectedEvents.map(formatEventCard) : [],
      });
    }

    const parsed = parseLlmJson(rawLlm);
    const reply =
      parsed && typeof parsed.reply === 'string' && parsed.reply.trim()
        ? parsed.reply.trim()
        : rawLlm.slice(0, 2000);

    const eventsOut = selectedEvents.length > 0 ? selectedEvents.map(formatEventCard) : [];

    console.log('Recommendation generated');

    await saveChatHistory(trimmed, reply);

    return res.json({
      reply,
      events: eventsOut,
    });
  } catch (error) {
    console.error('Chat error:', error);
    return res.status(500).json({
      reply: 'Something went wrong with the chat request 😵',
      error: error.message || 'Error processing your request',
      events: [],
    });
  }
});

app.get('/api/golive-image/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).send('Missing event id');
    const rows = await fetchGoLiveEventRows();
    const row = rows.find((r) => String(r.id) === id);
    const url = Array.isArray(row?.images) && row.images[0] ? row.images[0] : '';
    if (!url) return res.status(404).send('No image for this event');
    return res.redirect(302, url);
  } catch (err) {
    console.error('GoLive image proxy:', err.message);
    return res.status(502).send('Could not refresh GoLive image');
  }
});

app.get('/api/events', async (req, res) => {
  try {
    let merged = getCachedMergedScrapedEvents();

    const myrOnly = req.query.myrOnly === '1' || req.query.myrOnly === 'true';
    if (myrOnly) merged = merged.filter(isRinggitOrFreeEvent);

    res.set('Cache-Control', 'public, max-age=30');
    res.json(merged);
  } catch (err) {
    res.json({ count: 0, events: [], error: 'No data found. Run the scraper first.' });
  }
});

app.get('/api/itinerary/events', async (req, res) => {
  try {
    const q = normalizeText(req.query.q || '');
    const pool = getItineraryEventPool().map(eventOptionFromRow);
    const out = (q
      ? pool.filter((e) => normalizeText(`${e.title} ${e.venue} ${e.city}`).includes(q))
      : pool
    ).slice(0, 30);
    return res.json({ events: out });
  } catch (err) {
    return res.status(500).json({ events: [], error: err.message || 'Failed to list events' });
  }
});

app.post('/api/itinerary/plan', async (req, res) => {
  try {
    const pool = getItineraryEventPool();
    const selected = findEventForItinerary(pool, req.body || {});
    if (!selected) {
      return res.status(400).json({ error: 'Selected event not found. Choose an event from the list.' });
    }

    const style = String(req.body?.travelStyle || 'balanced').slice(0, 40);
    const adventure = String(req.body?.adventureLevel || 'medium').slice(0, 24);
    const days = Math.min(5, Math.max(1, Number(req.body?.days) || 2));
    const budget = String(req.body?.budget || 'mid').slice(0, 24);

    const eventCtx = eventOptionFromRow(selected);
    let plan = buildFallbackItinerary(eventCtx, {
      travelStyle: style,
      adventureLevel: adventure,
      days,
    });
    // Optional LLM enrichment. Keep deterministic guide as baseline.
    const useLlm = process.env.ITINERARY_USE_LLM === '1';
    if (useLlm) {
      try {
        const llmPlan = await generateItineraryWithDashScope({
          country: 'Malaysia',
          event: eventCtx,
          preferences: { travelStyle: style, adventureLevel: adventure, days, budget },
          constraints: {
            malaysiaOnly: true,
            keepPlacesNearEventCity: true,
          },
        });
        if (llmPlan && typeof llmPlan === 'object') {
          plan = {
            ...plan,
            ...llmPlan,
            event_context: llmPlan.event_context || plan.event_context,
            days: Array.isArray(llmPlan.days) && llmPlan.days.length ? llmPlan.days : plan.days,
          };
        }
      } catch {
        // keep deterministic plan
      }
    }

    return res.json({
      event: eventCtx,
      itinerary: plan,
      tips: {
        flights_link: 'https://www.google.com/travel/flights',
        hotels_link: `https://www.google.com/travel/hotels/${encodeURIComponent(
          selected.city || 'Malaysia',
        )}`,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to build itinerary' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Viewer running at http://localhost:${PORT}`);
  });
  // Optional: run scrape → upload → embeddings on the same process (cron in scheduler.js).
  // Set ENABLE_SCHEDULER=1 in `.env` — otherwise run `npm run scheduler` in a separate terminal.
  const enableSched =
    process.env.ENABLE_SCHEDULER === '1' ||
    process.env.ENABLE_SCHEDULER === 'true' ||
    process.env.ENABLE_SCHEDULER === 'yes';
  if (enableSched) {
    require('./scheduler');
    console.log('📅 Scheduler module loaded (ENABLE_SCHEDULER)');
  }
}

module.exports = { app };
