require('dotenv').config();
'use strict';

/**
 * Build embeddings via Hugging Face Inference API and store in Supabase.
 *
 * Model sentence-transformers/all-MiniLM-L6-v2 returns 384-dimensional vectors (not 1536).
 *
 * If Supabase says "expected 1536 dimensions, not 384", change the column to match the model:
 *
 *   ALTER TABLE event_embeddings_chatbot
 *     ALTER COLUMN embedding TYPE vector(384);
 *
 * (Or pick a different model whose output dimension matches your column.)
 *
 * Calls HF through @huggingface/inference (same model; correct routing vs raw fetch).
 */

const { createClient } = require('@supabase/supabase-js');
const { InferenceClient } = require('@huggingface/inference');

const HF_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const BATCH_SIZE = 10;
const DELAY_MS = 1000;
/**
 * Supabase enforces a per-request max row count (often 1000 in API settings).
 * Larger .range() does not bypass that — we page with repeated .range(offset, offset+page-1).
 */
/** Keep ≤ your Supabase “Max rows” API setting (default is often 1000). */
const PAGE_SIZE = Math.max(1, Number(process.env.SUPABASE_PAGE_SIZE) || 1000);

async function fetchAllRows(supabase, table, selectColumns) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(selectColumns)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildDescription(row) {
  const parts = [
    row.title,
    row.venue,
    row.date,
    row.price,
    row.category,
  ].filter((x) => x != null && String(x).trim() !== '');
  return parts.join('. ');
}

/** Mean-pool token vectors: tokens[i][d] -> one vector of length d */
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

/**
 * Normalize HF feature-extraction JSON to list of embedding vectors (each number[]).
 */
function parseFeatureExtractionOutput(data) {
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected HF response (not array): ${typeof data}`);
  }
  if (data.length === 0) return [];

  const first = data[0];

  // Token matrices (one or many docs): each item is [token][dim]
  if (Array.isArray(first) && first.length && Array.isArray(first[0]) && typeof first[0][0] === 'number') {
    return data.map((seq) => meanPoolTokens(seq));
  }

  // Batch of pooled vectors: [[...384], [...384]]
  if (Array.isArray(first) && typeof first[0] === 'number') {
    return data.map((row) => {
      if (!Array.isArray(row) || typeof row[0] !== 'number') {
        throw new Error('Mixed batch embedding shape');
      }
      return row;
    });
  }

  // Flat single vector [...384]
  if (typeof first === 'number') {
    return [data];
  }

  throw new Error('Could not parse embedding tensor shape from HF response');
}

/**
 * Calls Hugging Face Inference (feature extraction) for the same model you specified.
 * Uses @huggingface/inference so routing/payloads stay correct vs raw fetch.
 */
async function callHuggingFaceFeatureExtraction(token, inputs) {
  const client = new InferenceClient(token);
  const raw = await client.featureExtraction({
    model: HF_MODEL,
    inputs,
  });
  return parseFeatureExtractionOutput(raw);
}

async function createEmbeddings() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const hfKey = process.env.HUGGINGFACE_API_KEY;

  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or service secret in SUPABASE_KEY) in .env');
  }
  if (!hfKey) {
    throw new Error('Set HUGGINGFACE_API_KEY in .env');
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const existingRows = await fetchAllRows(supabase, 'event_embeddings_chatbot', 'event_id');
  const already = new Set(existingRows.map((r) => r.event_id));

  const events = await fetchAllRows(
    supabase,
    'events_chatbot',
    'id, title, venue, date, price, category',
  );
  console.log(`Loaded ${events.length} rows from events_chatbot (${existingRows.length} existing embeddings)`);

  const pending = (events || []).filter((e) => e.id != null && !already.has(e.id));
  const total = pending.length;
  let created = 0;

  if (total === 0) {
    console.log('Done! 0 embeddings created (all events already have embeddings).');
    return { created: 0, total: 0 };
  }

  for (let start = 0; start < total; start += BATCH_SIZE) {
    const batch = pending.slice(start, start + BATCH_SIZE);
    const texts = batch.map((e) => buildDescription(e));

    for (let i = 0; i < batch.length; i += 1) {
      const globalIdx = start + i + 1;
      console.log(`Processing event ${globalIdx}/${total}...`);
    }

    const embeddings = await callHuggingFaceFeatureExtraction(hfKey, texts);
    if (embeddings.length !== batch.length) {
      throw new Error(`Expected ${batch.length} embeddings, got ${embeddings.length}`);
    }

    for (let i = 0; i < batch.length; i += 1) {
      const ev = batch[i];
      const embedding = embeddings[i];
      const { error: insErr } = await supabase.from('event_embeddings_chatbot').insert({
        event_id: ev.id,
        embedding,
      });
      if (insErr) throw new Error(`Insert failed for "${ev.title}": ${insErr.message}`);
      created += 1;
      console.log(`Created embedding for [${(ev.title || '').slice(0, 80)}]`);
    }

    if (start + BATCH_SIZE < total) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`Done! ${created} embeddings created`);
  return { created, total };
}

if (require.main === module) {
  createEmbeddings().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { createEmbeddings };
