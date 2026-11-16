'use strict';
// Fails while anything temporary is still on the branch. Run before any merge request:  npm run premerge:check
// The first-administrator page exists only to set up staging without a terminal and MUST be removed before a merge.
const fs = require('node:fs');
const path = require('node:path');

const TEMPORARY = [
  ['admin/first-admin.html', 'temporary first-administrator page'],
  ['assets/first-admin.js', 'temporary first-administrator page script'],
  ['assets/pbkdf2-hash.js', 'browser password hashing used only by the temporary page'],
  ['staging-run', 'old request-file trigger (no longer used)'],
];

function blockers(root) {
  return TEMPORARY.filter(([f]) => fs.existsSync(path.join(root, f))).map(([f, why]) => f + '  (' + why + ')');
}

module.exports = { blockers, TEMPORARY };
if (require.main === module) {
  const found = blockers(path.join(__dirname, '..'));
  if (found.length) { console.error('NOT READY TO MERGE. Remove these first:\n  ' + found.join('\n  ')); process.exit(1); }
  console.log('Nothing temporary is left on the branch.');
}
