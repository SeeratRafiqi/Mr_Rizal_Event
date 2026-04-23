'use strict';

/**
 * Upload scraped event JSON files into Supabase table `events_chatbot`.
 * Requires: SUPABASE_URL, SUPABASE_KEY in .env
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs-extra');
const { createClient } = require('@supabase/supabase-js');

const DATA_DIR = path.join(__dirname, 'data');

const SOURCES = [
  { file: 'eventbrite-events.json', source: 'eventbrite', label: 'Eventbrite' },
  { file: 'ticket2u-events.json', source: 'ticket2u', label: 'Ticket2U' },
  { file: 'goliveasia-events.json', source: 'goliveasia', label: 'GoLive Asia' },
  { file: 'ticketmelon-events.json', source: 'ticketmelon', label: 'Ticketmelon' },
];

const CHUNK_SIZE = 200;

function mapEventToRow(event, source) {
  return {
    title: event.title ?? null,
    description: event.summary != null ? String(event.summary) : null,
    venue: event.venue ?? null,
    city: event.city != null && String(event.city).trim() !== '' ? String(event.city) : null,
    date: event.date != null && String(event.date).trim() !== '' ? String(event.date) : null,
    price: event.price != null && String(event.price).trim() !== '' ? String(event.price) : null,
    image_url: event.image != null && String(event.image).trim() !== '' ? String(event.image) : null,
    event_url: event.url != null && String(event.url).trim() !== '' ? String(event.url) : null,
    source,
    category: event.category != null && String(event.category).trim() !== '' ? String(event.category) : null,
    is_free: Boolean(event.isFree),
  };
}

async function insertRows(supabase, rows) {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase.from('events_chatbot').insert(chunk);
    if (error) {
      const msg = error.message || JSON.stringify(error);
      if (msg.includes('row-level security') || msg.includes('RLS')) {
        throw new Error(
          `Supabase insert failed (RLS): use SUPABASE_SERVICE_ROLE_KEY for server-side uploads, ` +
            `or add an INSERT policy for table events_chatbot. Original: ${msg}`,
        );
      }
      throw new Error(`Supabase insert failed: ${msg}`);
    }
  }
}

async function uploadToSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  /** Service role bypasses RLS; publishable/anon keys need matching INSERT policies. */
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL and a key: set SUPABASE_SERVICE_ROLE_KEY (recommended) or SUPABASE_KEY in .env');
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('Uploading events to Supabase...');
  let total = 0;

  for (const { file, source, label } of SOURCES) {
    const filePath = path.join(DATA_DIR, file);
    if (!(await fs.pathExists(filePath))) {
      console.log(`Skipping missing file: ${file}`);
      continue;
    }

    const raw = await fs.readJson(filePath);
    if (!Array.isArray(raw)) {
      console.log(`Skipping (not a JSON array): ${file}`);
      continue;
    }

    const rows = raw.map((e) => mapEventToRow(e, source));
    await insertRows(supabase, rows);
    const n = rows.length;
    total += n;
    console.log(`Uploaded ${n} events from ${label}`);
  }

  console.log(`Done! Total ${total} events uploaded`);
  return { total };
}

if (require.main === module) {
  uploadToSupabase().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { uploadToSupabase };
