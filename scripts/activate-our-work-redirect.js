'use strict';
// PREPARED, NOT ACTIVE. Run this only when /our-work is ready to replace the old /projects placeholder:
//   node scripts/activate-our-work-redirect.js           (edits vercel.json, then review the diff and deploy as normal)
//   node scripts/activate-our-work-redirect.js --check   (shows what would change, edits nothing)
// It adds permanent (301) redirects /projects and /projects/ -> /our-work, and points the existing /work redirect at
// /our-work directly so visitors never go through two redirects. Running it twice changes nothing the second time.
const fs = require('node:fs');
const path = require('node:path');

function activate(config) {
  const out = JSON.parse(JSON.stringify(config));
  out.redirects = (out.redirects || []).filter((r) => !['/projects', '/projects/', '/work'].includes(r.source));
  ['/work', '/projects', '/projects/'].forEach((source) => out.redirects.push({ source, destination: '/our-work', statusCode: 301 }));
  return out;
}

module.exports = { activate };

if (require.main === module) {
  const file = process.argv.find((a) => a.endsWith('.json')) || path.join(__dirname, '..', 'vercel.json');
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const after = activate(before);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (process.argv.includes('--check') || !changed) { console.log(changed ? 'Would change ' + file + ':\n' + JSON.stringify(after.redirects, null, 2) : 'Already active. Nothing to do.'); process.exit(0); }
  fs.writeFileSync(file, JSON.stringify(after, null, 2) + '\n');
  console.log('Updated ' + file + '. Review the diff, then deploy. /projects now redirects to /our-work.');
}
