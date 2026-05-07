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
  parseBareOrdinal,
  extractKeywords,
} = require('./chatbot-utils');

const app = express();
const PORT = Number(process.env.PORT) || 3040;

const HF_EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';

const RAG_SYSTEM_PROMPT = `You are a warm, fun, friendly friend helping someone discover events in Malaysia.
- Sound human: short-ish, punchy, natural emojis — not robotic or salesy.
- You only ever recommend from the event list the user message includes (JSON). Never invent venues, dates, or prices.
- CRITICAL: If the event list contains one or more events, you MUST acknowledge them warmly. NEVER say "no events", "nothing found", "I couldn't find any", or any similar negative phrase when the list is non-empty. The events have already been verified to match — trust the list.
- If the event list is empty (length 0), only then say you could not find matches and set show_events to false.
- Only recommend UPCOMING events (date is today or later). Never hype or feature events whose dates are before today unless the user clearly asked about the past or a specific past day.
- If every event in the JSON is in the past and the user did not ask about past events, say there are no good upcoming matches and set show_events to false.
- The user message includes a CALENDAR block with TODAY in Malaysia (Asia/Kuala_Lumpur). Treat it as the source of truth for phrases like "this year", "this month", "next month", and "next year". Never assume 2025 or any other year unless that block says so.
- This app does not sell tickets — point people to the event link on the source site for booking.
- Reply must be ONLY one JSON object, no markdown code fences, no text before or after:
{"reply":"<warm recommendation>","show_events":true|false}
show_events: true only when you are actually recommending specific events from the list.`;

const CASUAL_SYSTEM_PROMPT = `You are a warm, friendly assistant for discovering events in Malaysia.
The user is only greeting you or making small talk — they did NOT ask to see event listings or recommendations yet.
Reply in one short message (light emoji ok). Do NOT list events, venues, dates, or prices.
If the user message includes a CALENDAR line with TODAY in Malaysia, treat it as authoritative for the current year/month when you mention time casually.
Reply must be ONLY one JSON object:
{"reply":"<message>","show_events":false}`;

const INTENT_EXTRACTION_SYSTEM_PROMPT = `You are a date and intent extraction system for an event chatbot in Malaysia.

Your only job: read the user's message and return ONE JSON object describing what they want. NO markdown, NO commentary, NO code fences.

Output schema:
{
  "dateRange": {
    "from": "YYYY-MM-DD" or null,
    "to":   "YYYY-MM-DD" or null,
    "label": "human-readable description"
  },
  "keywords": ["specific topic words from the message"],
  "isEventRequest": true or false
}

DATE RULES (use TODAY from the user message as reference; never assume any other year):
- "before X"          → from = today,    to = X minus 1 day        (X excluded)
- "after X"           → from = X plus 1, to = today + 12 months    (X excluded)
- "by X" / "until X" / "no later than X" / "on or before X" → from = today, to = X (X included)
- "since X" / "starting X" / "on or after X" / "not before X" → from = X, to = today + 12 months (X included)
- "between X and Y" / "from X to Y"                          → from = X, to = Y (both included)
- Compound ("before X but after Y") → return the intersection range
- "tomorrow" / "today" / "tonight" → that single day
- "this weekend" / "weekend" → upcoming Saturday and Sunday
- "next weekend" → the weekend AFTER this weekend
- "next week"  → next Monday through Sunday
- "this month" / "next month" → 1st to last day of that month
- "in <Month>" → 1st to last day of the upcoming <Month>
- "the weekend after <date>" / "X days from <date>" → compute literally
- For relative phrases that depend on personal data ("the day after my birthday"), set from=null, to=null and note it in label.
- If no date constraint at all, set from=null, to=null.
- Always interpret naked months/days/weekdays as the upcoming occurrence, not the past.

KEYWORD RULES (used for SQL keyword search alongside vector search):
- Extract ONLY specific topic words: "cancer", "jazz", "BBC mandarin", "K-pop", "vegan", "jiu-jitsu", "anime", "trading"
- DO NOT include generic words: "events", "shows", "things", "fun", "happening", "stuff", "concert", "festival"
- DO NOT include date words: "today", "tomorrow", "weekend", "august", "this", "next"
- DO NOT include place words: city/area names like "KL", "Penang", "near me"
- DO NOT include budget words: "free", "cheap", "RM50"
- Return [] if nothing specific.

isEventRequest:
- true if user is asking for/about events, shows, things to do, plans, ideas
- false for greetings ("hi", "thanks") or unrelated chatter

EXAMPLES (assume today is 2026-05-06):
"events tomorrow"
→ {"dateRange":{"from":"2026-05-07","to":"2026-05-07","label":"tomorrow"},"keywords":[],"isEventRequest":true}

"any cancer events before 31 august but after 1 august"
→ {"dateRange":{"from":"2026-08-02","to":"2026-08-30","label":"between Aug 1 and Aug 31"},"keywords":["cancer"],"isEventRequest":true}

"events in the second half of august"
→ {"dateRange":{"from":"2026-08-16","to":"2026-08-31","label":"second half of August"},"keywords":[],"isEventRequest":true}

"the weekend after my birthday"
→ {"dateRange":{"from":null,"to":null,"label":"the weekend after the user's birthday (unknown)"},"keywords":[],"isEventRequest":true}

"hi"
→ {"dateRange":{"from":null,"to":null,"label":"any time"},"keywords":[],"isEventRequest":false}`;

const MALAYSIA_TZ = 'Asia/Kuala_Lumpur';

/** Authoritative "today" for the LLM so relative time (this year / next month) matches real Malaysia time, not model cutoff. */
function malaysiaCalendarBlock(now = new Date()) {
  const tz = MALAYSIA_TZ;
  const isoDate = now.toLocaleDateString('en-CA', { timeZone: tz });
  const longHuman = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const yearNum = Number(new Intl.DateTimeFormat('en', { timeZone: tz, year: 'numeric' }).format(now));
  return (
    `CALENDAR (authoritative — use for "this year"/"this month"/"next month"/"next year"):\n` +
    `Today in Malaysia (${tz}): ${longHuman} (ISO date ${isoDate}).\n` +
    `"This year" means ${yearNum}. Event dates in any JSON below use the same calendar; if a date shows ${yearNum} it is in ${yearNum}. Never contradict this block or claim a listed year is "wrong" vs an older training year.`
  );
}

const SUPABASE_TABLE_PAGE = Math.max(1, Number(process.env.SUPABASE_PAGE_SIZE) || 1000);

app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer.html'));
});

app.get('/flight-search.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'flight-search.js'));
});

app.get('/hotel-search.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'hotel-search.js'));
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

/**
 * SQL keyword search — runs in parallel with vector search to catch events whose
 * embedding either doesn't exist yet or ranks too low for the vector model
 * (e.g. rare proper-noun keywords like "cancer", "BBC Mandarin", "I Ching").
 *
 * For each keyword we OR-match across title / description / category / venue using ILIKE.
 * Returns up to `perKeyword * keywords.length` rows (deduped by id).
 */
async function keywordSearchEvents(supabase, keywords, perKeyword = 25) {
  if (!Array.isArray(keywords) || keywords.length === 0) return [];
  const seen = new Map();
  for (const kw of keywords) {
    const safe = String(kw).replace(/[%_\\]/g, ' ').trim();
    if (!safe) continue;
    const pattern = `%${safe}%`;
    const orFilter = [
      `title.ilike.${pattern}`,
      `description.ilike.${pattern}`,
      `category.ilike.${pattern}`,
      `venue.ilike.${pattern}`,
    ].join(',');
    const { data, error } = await supabase
      .from('events_chatbot')
      .select('id, title, description, venue, city, date, price, image_url, event_url, source, category, is_free')
      .or(orFilter)
      .order('date', { ascending: true })
      .limit(perKeyword);
    if (error) {
      console.warn(`Keyword search for "${kw}" failed:`, error.message);
      continue;
    }
    for (const row of data || []) {
      if (!seen.has(row.id)) seen.set(row.id, row);
    }
  }
  return [...seen.values()];
}

/**
 * Hard keyword filter: keep only events whose text contains at least one of
 * the given keywords (OR semantics). Prevents vector-search bleed-through
 * where semantically related (but topically wrong) events pollute results.
 *
 * Example: query "any cancer events" → keywords ["cancer"] → only events
 * with "cancer" in title/description/category/venue/city pass.
 *
 * If keywords is empty, returns events unchanged.
 * If filter would leave 0 events, returns 0 — that's the correct answer
 * (better to say "no matches" than show irrelevant ones).
 */
function applyKeywordFilter(events, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return events;
  if (!Array.isArray(events) || events.length === 0) return events;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const lowerKw = keywords
    .map((k) => norm(k).trim())
    .filter((k) => k.length >= 2);
  if (lowerKw.length === 0) return events;
  return events.filter((event) => {
    const haystack = norm(
      [event.title, event.description, event.summary, event.category, event.venue, event.city]
        .filter(Boolean)
        .join(' '),
    );
    return lowerKw.some((k) => haystack.includes(k));
  });
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

  const eventCountLine = slimEvents.length > 0
    ? `IMPORTANT: The system found ${slimEvents.length} matching event(s) for this request. You MUST mention them — do NOT say no events were found.`
    : `IMPORTANT: No matching events were found. Tell the user politely and set show_events to false.`;

  const userBlock = [
    `${malaysiaCalendarBlock()}\n`,
    histText ? `Prior chat:\n${histText}\n` : '',
    `User question:\n${message}\n`,
    `${eventCountLine}\n`,
    `Here are ${slimEvents.length} relevant events from Malaysia (JSON):\n${JSON.stringify(slimEvents)}\n`,
    slimEvents.length > 0
      ? `Generate a warm, friendly recommendation. Mention the events above by name and why they match the request.`
      : `Generate a warm, friendly apology that no events matched.`,
    `Return ONLY JSON: {"reply":"...","show_events":${slimEvents.length > 0 ? 'true' : 'false'}}`,
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
    `${malaysiaCalendarBlock()}\n`,
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

// ---------------------------------------------------------------------------
// Hybrid intent extraction: rule-based first, LLM only for "complex" queries
// ---------------------------------------------------------------------------

/**
 * Heuristic that decides whether the rule-based parser is likely to be wrong
 * for the given message, and we should ask the LLM to extract intent instead.
 *
 * The goal: keep simple queries on the fast (free, instant) rule path, and
 * only spend an LLM call when the message contains operators/negation/compound
 * phrases that the regex parser cannot reliably handle.
 */
function needsLlmIntent(message, ruleIntent) {
  if (!message) return false;
  const msg = String(message);
  const dayType = ruleIntent && ruleIntent.day && ruleIntent.day.type;

  // 1. Operator / range words present, but rule parser failed to produce a date_range
  //    (it returned 'any', 'specific_date', 'month', etc.) — likely a miss.
  const hasOperatorWord =
    /\b(?:before|after|until|till|by|since|between|from)\b/i.test(msg) ||
    /\b(?:earlier than|later than|prior to|no later than|on or (?:before|after)|not (?:before|after))\b/i.test(msg);
  if (hasOperatorWord && dayType !== 'date_range') return true;

  // 2. Compound relative phrases ("the weekend after X", "3 days from now",
  //    "month after next") — beyond the regex parser's vocabulary.
  if (/\b(?:weekend|day|days|month|months|week|weeks|year|years)\s+after\b/i.test(msg)) return true;
  if (/\bafter\s+(?:that|this|next)\b/i.test(msg)) return true;
  if (/\b\d+\s+(?:days?|weeks?|months?)\s+(?:from|after)\s+now\b/i.test(msg)) return true;
  if (/\bmonth\s+after\s+next\b/i.test(msg)) return true;
  if (/\b(?:first|second|third|last|early|mid|late|end of|beginning of)\s+(?:half\s+of\s+|part\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|month|week)\b/i.test(msg)) return true;

  // 3. Negation / exclusion with date context ("not on weekends", "except sunday")
  if (/\bnot\s+(?:on|in|during|at|this|next|the)\b/i.test(msg)) return true;
  if (/\bexcept\b/i.test(msg)) return true;
  if (/\bother than\b/i.test(msg)) return true;
  if (/\bavoid\b/i.test(msg)) return true;

  // 4. Personal / contextual references the regex can never resolve
  if (/\bmy\s+(?:birthday|anniversary|graduation|wedding|holiday|trip|leave)\b/i.test(msg)) return true;

  return false;
}

/**
 * Ask the LLM to extract structured intent (dateRange + keywords) from the
 * user's message. Returns null on any failure so the caller falls back to the
 * rule-based result. Strict JSON output expected.
 */
async function extractIntentViaLlm(message, history) {
  const hist = Array.isArray(history) ? history : [];
  // Only the last few user turns help; assistant turns rarely carry useful date
  // anchors and can mislead the model.
  const histText = hist
    .filter((h) => h && h.role === 'user' && h.content)
    .slice(-3)
    .map((h, i) => `previous_user_${i + 1}: ${String(h.content).slice(0, 300)}`)
    .join('\n');

  const userBlock = [
    `${malaysiaCalendarBlock()}\n`,
    histText ? `Recent context:\n${histText}\n` : '',
    `User message: "${String(message).slice(0, 600)}"`,
    `Return ONLY the JSON object described in the system prompt. No markdown.`,
  ]
    .filter(Boolean)
    .join('\n');

  const hasDash = Boolean(process.env.DASHSCOPE_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  let raw;
  try {
    if (hasDash) {
      raw = await chatRagDashScope(userBlock, INTENT_EXTRACTION_SYSTEM_PROMPT);
    } else if (hasAnthropic) {
      raw = await chatRagAnthropic(userBlock, INTENT_EXTRACTION_SYSTEM_PROMPT);
    } else {
      return null;
    }
  } catch (err) {
    console.warn('LLM intent extraction failed:', err.message);
    return null;
  }

  const parsed = parseLlmJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    console.warn('LLM intent JSON parse failed. Raw:', String(raw).slice(0, 200));
    return null;
  }

  // Normalize and sanity-check
  const dr = parsed.dateRange && typeof parsed.dateRange === 'object' ? parsed.dateRange : {};
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = typeof dr.from === 'string' && isoRe.test(dr.from) ? dr.from : null;
  const to = typeof dr.to === 'string' && isoRe.test(dr.to) ? dr.to : null;
  const label = typeof dr.label === 'string' ? dr.label.slice(0, 120) : '';

  let keywords = [];
  if (Array.isArray(parsed.keywords)) {
    keywords = parsed.keywords
      .filter((k) => typeof k === 'string')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length >= 2 && k.length <= 40)
      .slice(0, 6);
  }

  const isEventRequest = parsed.isEventRequest !== false; // default true unless explicitly false

  return { from, to, label, keywords, isEventRequest };
}

/**
 * Materialize an LLM-extracted dateRange into the same `day` object shape the
 * rest of the pipeline already understands (dates: [...] for filtering).
 */
function llmIntentToDayObject(llmIntent) {
  if (!llmIntent || (!llmIntent.from && !llmIntent.to)) return { type: 'any' };
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: MALAYSIA_TZ });
  const from = llmIntent.from || todayStr;
  // Cap at +12 months if no upper bound
  const fallbackTo = (() => {
    const [y, m, d] = todayStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCMonth(dt.getUTCMonth() + 12);
    return dt.toISOString().slice(0, 10);
  })();
  const to = llmIntent.to || fallbackTo;

  // BUG-FIX (timezone): build the date list with UTC arithmetic. Previously
  // `new Date('2026-05-18T00:00:00')` was parsed in LOCAL time (Malaysia +8),
  // then .toISOString() shifted back 8 h, yielding "2026-05-17" — so every
  // date in the range was off by one day and events from the day BEFORE the
  // intended window leaked through the filter.
  const parseISO = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  };
  const start = parseISO(from);
  const end = parseISO(to);
  if (!start || !end || end < start) return { type: 'any' };

  const dates = [];
  const cursor = new Date(start);
  let safety = 0;
  while (cursor <= end && safety < 400) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    safety += 1;
  }

  return {
    type: 'date_range',
    label: llmIntent.label || `${from} → ${to}`,
    from,
    to,
    dates,
    source: 'llm',
  };
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
    let effectiveDay;
    if (latestIntent.day?.type !== 'any') {
      // Current message has a full parseable date — always use it
      effectiveDay = latestIntent.day;
    } else {
      // Current message has no full date. Check for a bare ordinal like "how about 10th".
      // If found, inherit the month from the last known date in the merged history context
      // so "how about 10th" after "events on 5th may" correctly resolves to May 10th.
      const bareDay = parseBareOrdinal(trimmed.toLowerCase());
      if (bareDay !== null && mergedIntent.day?.dates?.length > 0) {
        const lastKnown = mergedIntent.day.dates[mergedIntent.day.dates.length - 1];
        const parts = lastKnown.split('-').map(Number); // [yyyy, mm, dd]
        const todayStr = todayISO();
        const candidate = new Date(Date.UTC(parts[0], parts[1] - 1, bareDay));
        if (!Number.isNaN(candidate.getTime()) && candidate.getUTCDate() === bareDay) {
          let candidateISO = candidate.toISOString().slice(0, 10);
          // If the inferred date is already in the past, try the next month
          if (candidateISO < todayStr) {
            const nextMonth = new Date(Date.UTC(parts[0], parts[1], bareDay));
            if (!Number.isNaN(nextMonth.getTime()) && nextMonth.getUTCDate() === bareDay) {
              candidateISO = nextMonth.toISOString().slice(0, 10);
            }
          }
          if (candidateISO >= todayStr) {
            effectiveDay = { type: 'specific_date', label: candidateISO, dates: [candidateISO] };
          } else {
            effectiveDay = mergedIntent.day;
          }
        } else {
          effectiveDay = mergedIntent.day;
        }
      } else {
        effectiveDay = mergedIntent.day;
      }
    }

    intent = {
      ...mergedIntent,
      budget: latestIntent.budget?.type !== 'any' || Number.isFinite(latestIntent.budget?.maxPrice)
        ? latestIntent.budget
        : mergedIntent.budget,
      mood: latestIntent.mood?.length > 0 ? latestIntent.mood : mergedIntent.mood,
      day: effectiveDay,
      audience: latestIntent.audience,
      isEventRequest: latestIntent.isEventRequest || mergedIntent.isEventRequest,
    };
  } else {
    // NEW QUERY — use the latest message as the full intent (ignore history context)
    intent = { ...latestIntent };
  }
  // Past mode only from the *current* message — never from older chat lines (prevents past events in "suggest something fun").
  intent.askingAboutPast = latestIntent.askingAboutPast === true;

  // ----------------------------------------------------------------------
  // HYBRID INTENT: hand off to LLM for "complex" queries the regex parser
  // can't reliably handle (operators, negation, compound relative phrases,
  // personal references). Simple queries stay on the fast rule path.
  // The LLM's keywords (if any) override extractKeywords() for the search.
  // ----------------------------------------------------------------------
  let llmKeywordsOverride = null;
  if (latestIntent.isEventRequest && needsLlmIntent(trimmed, intent)) {
    console.log(`Hybrid intent: routing "${trimmed.slice(0, 80)}" to LLM (rule day=${intent.day?.type})`);
    const llmIntent = await extractIntentViaLlm(trimmed, history);
    if (llmIntent) {
      console.log(
        `LLM intent → from=${llmIntent.from} to=${llmIntent.to} kw=[${llmIntent.keywords.join(', ')}] label="${llmIntent.label}"`,
      );
      // If LLM produced any usable date bound, replace intent.day so the
      // existing date-specific filter path picks it up.
      if (llmIntent.from || llmIntent.to) {
        const llmDay = llmIntentToDayObject(llmIntent);
        if (llmDay.type === 'date_range') {
          intent.day = llmDay;
        }
      }
      // Always trust LLM's keyword extraction over the regex stopword list
      // when LLM is invoked — it does a better job ignoring filler words.
      if (Array.isArray(llmIntent.keywords)) {
        llmKeywordsOverride = llmIntent.keywords;
      }
      // LLM is also a sanity check on isEventRequest; only downgrade if the
      // model is confident this is small talk.
      if (llmIntent.isEventRequest === false) intent.isEventRequest = false;
    } else {
      console.log('LLM intent extraction returned null — staying on rule-based intent');
    }
  }

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

  if (!intent.isEventRequest || forceCasual) {
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

    // Extract topic keywords once — used by both BRANCH 1 (date-specific) and
    // BRANCH 2 (RAG) for the strict post-filter, and by BRANCH 2 for SQL
    // ILIKE search. Prefer LLM-extracted keywords (they ignore filler words
    // better) over the regex stopword filter when available.
    //
    // For REFINEMENT turns ("any more?", "what about saturday?"), pull keywords
    // from the merged context so the topic ("cancer", "jazz") carries forward;
    // for FRESH turns, only the latest message — prevents stale topic bleed.
    const keywordSource = isRefinement ? intentContext : trimmed;
    const rawKeywords = (llmKeywordsOverride && llmKeywordsOverride.length > 0)
      ? llmKeywordsOverride
      : extractKeywords(keywordSource, 5);

    // Validate keywords against the DB — drop any that have ZERO matches in
    // the entire events_chatbot table. This prevents typos ("evenys" instead
    // of "events") and arbitrary noise words from killing every result via
    // the strict post-filter. Real topics like "cancer", "jazz", "marathon"
    // always have at least one DB match (otherwise nothing to strict-filter
    // against in the first place).
    let keywords = rawKeywords;
    if (rawKeywords.length > 0) {
      const validationHits = await keywordSearchEvents(getSupabase(), rawKeywords, 1);
      const validKw = new Set();
      for (const row of validationHits) {
        const hay = ([row.title, row.description, row.category, row.venue, row.city]
          .filter(Boolean).join(' ')).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
        for (const kw of rawKeywords) {
          if (hay.includes(String(kw).toLowerCase())) validKw.add(kw);
        }
      }
      keywords = rawKeywords.filter((k) => validKw.has(k));
      const dropped = rawKeywords.filter((k) => !validKw.has(k));
      if (dropped.length > 0) {
        console.log(
          `Dropped noise keywords (0 DB matches, likely typo/non-existent): [${dropped.join(', ')}]`,
        );
      }
    }
    if (keywords.length > 0) {
      console.log(
        `Topic keywords (${llmKeywordsOverride ? 'llm' : 'rule'}, src=${isRefinement ? 'merged' : 'latest'}): [${keywords.join(', ')}]`,
      );
    }

    if (dateSpecific) {
      console.log('Date-specific request: scanning events_chatbot for exact date filter');
      const allRows = await fetchAllEventsChatbotRows(getSupabase());
      let allEvents = allRows.map(dbRowToEvent);
      // BUG-FIX (recall): apply strict keyword filter to the FULL candidate
      // pool BEFORE filterEventsByPreferences ranks/diversifies. Otherwise
      // the source-diversity pass inside filterEventsByPreferences may evict
      // relevant events to make room for irrelevant ones from other sources.
      if (keywords.length > 0) {
        const beforeKw = allEvents.length;
        allEvents = applyKeywordFilter(allEvents, keywords);
        console.log(`Topic pre-filter (date branch): ${beforeKw} → ${allEvents.length} match [${keywords.join(', ')}]`);
      }
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
      // Run vector search and SQL keyword search in parallel.
      // Keyword search catches events whose embedding doesn't exist yet OR whose
      // vector similarity for the user's query falls outside top-N (vector model
      // dilutes rare keywords like "cancer", "BBC Mandarin").
      // `keywords` is hoisted from above and used both here for SQL search and
      // later by applyKeywordFilter as a strict topic post-filter.
      const [vectorRes, keywordRows] = await Promise.all([
        getSupabase().rpc('match_events_chatbot_rag', {
          query_embedding: queryEmbedding,
          match_count: matchCount,
        }),
        keywords.length > 0
          ? keywordSearchEvents(getSupabase(), keywords, 25)
          : Promise.resolve([]),
      ]);
      const { data: matches, error: rpcErr } = vectorRes;
      console.log(`Keyword search returned ${keywordRows.length} extra rows`);

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

      // Merge vector + keyword results, vector takes priority on duplicates.
      const merged = rows.map(dbRowToEvent);
      const vectorIds = new Set(merged.map((e) => e.id));
      for (const kr of keywordRows) {
        if (!vectorIds.has(kr.id)) merged.push(dbRowToEvent(kr));
      }
      let eventsForCards = merged;
      if (!intent.askingAboutPast) {
        eventsForCards = filterFutureEvents(eventsForCards);
      }
      // BUG-FIX (recall): apply the strict keyword filter EARLY — to the full
      // merged pool (vector + keyword search) — BEFORE selectDiverseRecommendations
      // limits to 15 with source diversity. Otherwise the diversity pass can
      // evict relevant cancer/jazz/etc. events because of source quotas, and
      // the post-filter then has nothing to keep. Filtering first means
      // diversity picks among already-relevant events.
      if (keywords.length > 0) {
        const beforeKw = eventsForCards.length;
        eventsForCards = applyKeywordFilter(eventsForCards, keywords);
        console.log(`Topic pre-filter (RAG branch): ${beforeKw} → ${eventsForCards.length} match [${keywords.join(', ')}]`);

        // If keyword filter wiped the merged pool but keyword search itself
        // returned rows directly from DB, fall back to those (they're already
        // proven to contain the keyword). Catches the case where vector
        // search overpowered keyword rows in the merge.
        if (eventsForCards.length === 0 && keywordRows.length > 0) {
          eventsForCards = keywordRows.map(dbRowToEvent);
          if (!intent.askingAboutPast) eventsForCards = filterFutureEvents(eventsForCards);
          console.log(`Topic pre-filter empty pool; fell back to ${eventsForCards.length} keyword-search rows`);
        }
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
          if (keywords.length > 0) {
            allEvents = applyKeywordFilter(allEvents, keywords);
          }
          selectedEvents = filterEventsByPreferences(allEvents, intent);
        }
      } else {
        let pool = dedupeEventsForRecommendations(eventsForCards);
        // Source blending only when there are no topic keywords — otherwise
        // we'd dilute the relevant pool with random catalog events.
        if (keywords.length === 0 && poolNeedsSourceBlend(pool)) {
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

    // SAFETY NET — strict keyword filter is normally applied EARLIER (before
    // the diversity/limit step) so we don't lose relevant events. This pass
    // is a no-op in the common case but guards against any code path that
    // reintroduces unrelated events later.
    if (keywords.length > 0 && selectedEvents.length > 0) {
      const before = selectedEvents.length;
      selectedEvents = applyKeywordFilter(selectedEvents, keywords);
      if (selectedEvents.length !== before) {
        console.log(`Topic safety post-filter: ${before} → ${selectedEvents.length} match [${keywords.join(', ')}]`);
      }
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

/**
 * AirLabs Routes DB — timetable-style routes between airports (all airlines on that pair).
 * Unlike /schedules (gate board, ~10h lookahead), routes match “what flies this pair” for planning.
 */
app.get('/api/airlabs/routes', async (req, res) => {
  const dep = String(req.query.dep_iata || '')
    .trim()
    .toUpperCase();
  const arr = String(req.query.arr_iata || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(dep) || !/^[A-Z]{3}$/.test(arr)) {
    return res.status(400).json({ error: 'dep_iata and arr_iata must be 3-letter IATA codes', response: [] });
  }
  const apiKey = (process.env.VITE_AIRLABS_API_KEY || process.env.AIRLABS_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({
      error: 'AirLabs API key not configured. Set VITE_AIRLABS_API_KEY in .env',
      response: [],
    });
  }
  const airline = String(req.query.airline_iata || '').trim().toUpperCase();
  const all = [];
  let offset = 0;
  const limit = 50;
  const maxPages = 12;

  try {
    for (let page = 0; page < maxPages; page++) {
      const params = {
        dep_iata: dep,
        arr_iata: arr,
        api_key: apiKey,
        limit,
        offset,
      };
      if (airline.length === 2) params.airline_iata = airline;

      const { data } = await axios.get('https://airlabs.co/api/v9/routes', {
        params,
        timeout: 30000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'TicketScraper/1.0 (itinerary flight routes; localhost dev)',
        },
      });

      const batch = Array.isArray(data.response) ? data.response : [];
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }

    res.set('Cache-Control', 'public, max-age=3600');
    return res.json({ response: all });
  } catch (err) {
    const status = err.response?.status;
    console.error('[airlabs routes]', status || err.message);
    return res.status(502).json({
      error: err.response?.data?.message || err.message || 'AirLabs routes request failed',
      response: [],
    });
  }
});

/** AirLabs schedules (real-time, ~10h lookahead) — optional; not used for date-based trip planning. */
app.get('/api/airlabs/schedules', async (req, res) => {
  const dep = String(req.query.dep_iata || '')
    .trim()
    .toUpperCase();
  const arr = String(req.query.arr_iata || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(dep) || !/^[A-Z]{3}$/.test(arr)) {
    return res.status(400).json({ error: 'dep_iata and arr_iata must be 3-letter IATA codes', response: [] });
  }
  const apiKey = (process.env.VITE_AIRLABS_API_KEY || process.env.AIRLABS_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({
      error: 'AirLabs API key not configured. Set VITE_AIRLABS_API_KEY in .env',
      response: [],
    });
  }
  try {
    const params = { dep_iata: dep, arr_iata: arr, api_key: apiKey };
    const airline = String(req.query.airline_iata || '').trim().toUpperCase();
    if (airline.length === 2) params.airline_iata = airline;

    const { data } = await axios.get('https://airlabs.co/api/v9/schedules', {
      params,
      timeout: 30000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TicketScraper/1.0 (itinerary flight search; localhost dev)',
      },
    });
    res.set('Cache-Control', 'public, max-age=120');
    return res.json(data);
  } catch (err) {
    const status = err.response?.status;
    console.error('[airlabs schedules]', status || err.message);
    return res.status(502).json({
      error: err.response?.data?.message || err.message || 'AirLabs request failed',
      response: [],
    });
  }
});

/**
 * Nominatim reverse geocode (server-side User-Agent per OSM policy).
 * Query: lat, lng (or lon for compatibility)
 */
app.get('/api/geocode/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng ?? req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng (or lon) required' });
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'lat/lng out of range' });
  }
  try {
    const { data } = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon: lng, format: 'json' },
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TicketScraper-TripPlanner/1.0 (flight-search geocode)',
      },
    });
    res.set('Cache-Control', 'private, max-age=300');
    return res.json(data);
  } catch (err) {
    console.error('[nominatim]', err.message);
    return res.status(502).json({ error: err.message || 'Geocoding failed' });
  }
});

const { registerItineraryRoutes } = require('./itinerary-routes');
registerItineraryRoutes(app, { getSupabase, getMergedScrapedEvents: getCachedMergedScrapedEvents });

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
