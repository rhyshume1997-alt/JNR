'use strict';
// Removes photo uploads that were started but never finished (a phone lost signal, the tab was closed), older than 24 hours:
// the database row and the private original. Also retries any object a photo removal could not delete at the time (recorded in the
// audit history as storage_delete_failed, last 60 days). Deleting an object that is already gone is not an error. Safe to run any time.
//   DATABASE_URL=... S3_...=... node scripts/cleanup-orphans.js [--dry-run]
const { query, closePool } = require('../api/_lib/db');
const { storage } = require('../api/_lib/s3');
const E = require('../api/_lib/entries');

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
  const failed = await query("select detail from audit_log where action = 'storage_delete_failed' and at > now() - interval '60 days'");
  let retried = 0;
  for (const r of failed.rows) {
    for (const entry of (r.detail && r.detail.keys) || []) {
      const i = entry.indexOf(':'); const bucket = entry.slice(0, i) === 'public' ? 'publicBucket' : 'privateBucket'; const key = entry.slice(i + 1);
      if (dry) { console.log('would retry ' + entry); continue; }
      try { await storage.del(bucket, key); retried++; } catch (e) { console.error('storage delete failed again for ' + entry + ': ' + e.message); }
    }
  }
  if (!dry) console.log('Released ' + (await E.releasePublicCopies()) + ' public photo copy/copies no longer used by the live site or a Buffer draft.');
  console.log((dry ? 'Found ' : 'Retried ') + (dry ? failed.rows.length + ' record(s) of' : retried) + ' object delete(s) that had failed earlier.');
}
main().then(() => closePool(), (e) => { console.error(e.message); process.exit(1); });
