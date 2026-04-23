require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { HfInference } = require('@huggingface/inference');

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '',
);
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
} = require('./chatbot-utils');

const app = express();
const PORT = Number(process.env.PORT) || 3040;

const HF_EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';

const RAG_SYSTEM_PROMPT = `You are a warm, fun, friendly friend helping someone discover events in Malaysia.
- Sound human: short-ish, punchy, natural emojis — not robotic or salesy.
- You only ever recommend from the event list the user message includes (JSON). Never invent venues, dates, or prices.
- If the event list is empty, say you could not find matches and set show_events to false.
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
  const id = event.id;
  if (id == null || String(id).trim() === '') return event;
  const sid = encodeURIComponent(String(id));
  if (String(event.image || '').includes(`/api/golive-image/${sid}`)) return event;
  return { ...event, image: `/api/golive-image/${sid}` };
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
    const { error } = await supabase.from('chat_history_chatbot').insert({
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
  const latestHasExplicitFilter =
    latestIntent.day?.type !== 'any' ||
    latestIntent.place?.mode !== 'any' ||
    latestIntent.budget?.type !== 'any' ||
    Number.isFinite(latestIntent.budget?.maxPrice) ||
    (Array.isArray(latestIntent.mood) && latestIntent.mood.length > 0);
  const intent = latestHasExplicitFilter ? latestIntent : mergedIntent;
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
      const allRows = await fetchAllEventsChatbotRows(supabase);
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

      const matchCount = hasExplicitFilter ? 100 : 30;
      const { data: matches, error: rpcErr } = await supabase.rpc('match_events_chatbot_rag', {
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

      const eventsForCards = rows.map(dbRowToEvent);
      if (hasExplicitFilter) {
        selectedEvents = filterEventsByPreferences(eventsForCards, intent);
        if (selectedEvents.length === 0) {
          console.log('Vector + filter empty; full table scan');
          const allRows = await fetchAllEventsChatbotRows(supabase);
          selectedEvents = filterEventsByPreferences(allRows.map(dbRowToEvent), intent);
        }
      } else {
        selectedEvents = eventsForCards.slice(0, 15);
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
    const eventbrite = JSON.parse(fs.readFileSync('data/eventbrite-events.json', 'utf-8'));
    const ticket2u = JSON.parse(fs.readFileSync('data/ticket2u-events.json', 'utf-8'));
    const goliveasia = fs.existsSync('data/goliveasia-events.json')
      ? JSON.parse(fs.readFileSync('data/goliveasia-events.json', 'utf-8'))
      : [];
    const ticketmelon = fs.existsSync('data/ticketmelon-events.json')
      ? JSON.parse(fs.readFileSync('data/ticketmelon-events.json', 'utf-8'))
      : [];

    let merged = [
      ...eventbrite.map((e) => ({ ...e, _source: 'eventbrite' })),
      ...ticket2u.map((e) => ({ ...e, _source: 'ticket2u' })),
      ...goliveasia.map((e) => ({ ...e, _source: 'goliveasia' })),
      ...ticketmelon.map((e) => ({ ...e, _source: 'ticketmelon' })),
    ];

    const myrOnly = req.query.myrOnly === '1' || req.query.myrOnly === 'true';
    if (myrOnly) merged = merged.filter(isRinggitOrFreeEvent);

    merged = merged.map(rewriteGoLiveImageForClient);

    res.json(merged);
  } catch (err) {
    res.json({ count: 0, events: [], error: 'No data found. Run the scraper first.' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Viewer running at http://localhost:${PORT}`);
  });
}

module.exports = { app };
