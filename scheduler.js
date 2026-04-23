const cron = require('node-cron');
const { scrapeEventbrite } = require('./eventbrite-scraper');
const { scrapeTicket2U } = require('./ticket2u-scraper');
const { scrapeGoLiveAsia } = require('./goliveasia-scraper');
const { scrapeTicketmelon } = require('./ticketmelon-scraper');
const { uploadToSupabase } = require('./upload-to-supabase');
const { createEmbeddings } = require('./create-embeddings');

const SCHEDULE = process.env.SCRAPER_CRON || '0 */6 * * *';
const RUN_ON_STARTUP = process.env.SCRAPER_RUN_ON_STARTUP !== '0';
let isRunning = false;

async function runPipeline(trigger) {
  if (isRunning) {
    console.log(`[scheduler] Skip ${trigger} run: previous run still in progress`);
    return;
  }
  isRunning = true;

  const ts = new Date().toISOString();
  console.log(`\n[scheduler] ${ts} Starting ${trigger} pipeline...`);

  try {
    try {
      console.log('[scheduler] Running Eventbrite scraper...');
      const ebEvents = await scrapeEventbrite();
      console.log(`[scheduler] ✅ Eventbrite: ${ebEvents.length} events`);
    } catch (err) {
      console.error('[scheduler] ❌ Eventbrite failed:', err.message);
    }

    try {
      console.log('[scheduler] Running Ticket2U scraper...');
      const t2uEvents = await scrapeTicket2U();
      console.log(`[scheduler] ✅ Ticket2U: ${t2uEvents.length} events`);
    } catch (err) {
      console.error('[scheduler] ❌ Ticket2U failed:', err.message);
    }

    try {
      console.log('[scheduler] Running GoLive Asia scraper...');
      const glaEvents = await scrapeGoLiveAsia();
      console.log(`[scheduler] ✅ GoLive Asia: ${glaEvents.length} events`);
    } catch (err) {
      console.error('[scheduler] ❌ GoLive Asia failed:', err.message);
    }

    try {
      console.log('[scheduler] Running Ticketmelon scraper...');
      const tmEvents = await scrapeTicketmelon();
      console.log(`[scheduler] ✅ Ticketmelon: ${tmEvents.length} events`);
    } catch (err) {
      console.error('[scheduler] ❌ Ticketmelon failed:', err.message);
    }

    try {
      console.log('[scheduler] Uploading scraped files to Supabase...');
      const { total } = await uploadToSupabase();
      console.log(`[scheduler] ✅ Uploaded ${total} rows to events_chatbot`);
    } catch (err) {
      console.error('[scheduler] ❌ Upload failed:', err.message);
    }

    try {
      console.log('[scheduler] Creating embeddings for new events...');
      const { created, total } = await createEmbeddings();
      console.log(`[scheduler] ✅ Embeddings done: ${created} created from ${total} pending`);
    } catch (err) {
      console.error('[scheduler] ❌ Embedding step failed:', err.message);
    }

    console.log('[scheduler] ✅ Pipeline completed\n');
  } finally {
    isRunning = false;
  }
}

cron.schedule(SCHEDULE, async () => {
  await runPipeline('scheduled');
});

console.log(`📅 Scheduler started — cron: "${SCHEDULE}"`);
console.log('   Pipeline: scrape -> upload -> create embeddings');
if (RUN_ON_STARTUP) {
  runPipeline('startup').catch((err) => {
    console.error('[scheduler] Startup pipeline failed:', err.message || err);
  });
}
