'use strict';
// Removes photo uploads that were started but never finished (a phone lost signal, the tab was closed), older than 24 hours:
// the database row and the private original. Safe to run any time, for example weekly.
//   DATABASE_URL=... S3_...=... node scripts/cleanup-orphans.js [--dry-run]
const { query, closePool } = require('../api/_lib/db');
const { storage } = require('../api/_lib/s3');

async function main() {
  const dry = process.argv.includes('--dry-run');
  const { rows } = await query("select id, original_key from entry_images where state = 'awaiting_upload' and created_at < now() - interval '24 hours'");
  let removed = 0;
  for (const r of rows) {
    if (dry) { console.log('would remove ' + r.original_key); continue; }
    try { await storage.del('privateBucket', r.original_key); } catch (e) { console.error('storage delete failed for ' + r.original_key + ': ' + e.message); continue; }
    await query('delete from entry_images where id = $1', [r.id]); removed++;
  }
  console.log((dry ? 'Found ' : 'Removed ') + (dry ? rows.length : removed) + ' abandoned upload(s).');
}
main().then(() => closePool(), (e) => { console.error(e.message); process.exit(1); });
