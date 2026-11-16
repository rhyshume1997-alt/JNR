'use strict';
// Decides which staging run the GitHub Action should do. The mode comes either from the manual-run input or from the `mode:`
// line of staging-run/request.txt (so a run can be requested by editing that one file in the browser).
// Prints mode=<mode> (and writes it to $GITHUB_OUTPUT when running in Actions). Anything unrecognised is an error, never a guess.
const fs = require('node:fs');
const path = require('node:path');

const MODES = ['none', 'services', 'check', 'e2e', 'e2e-draft'];

function readMode(env, file) {
  const fromInput = String(env.MODE_INPUT || '').trim();
  let mode;
  if (env.EVENT_NAME === 'workflow_dispatch') mode = fromInput || 'none';
  else {
    if (!fs.existsSync(file)) return 'none';
    const m = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => /^mode:\s*(.*)$/i.exec(l)).find(Boolean); // any text after "mode:" counts, so a typo is an error, not a silent no-op
    mode = m ? m[1].trim().toLowerCase() : 'none';
  }
  if (!MODES.includes(mode)) throw new Error('Unknown mode "' + String(mode).slice(0, 30) + '". Use one of: ' + MODES.join(', ') + '.');
  return mode;
}

module.exports = { readMode, MODES };
if (require.main === module) {
  try {
    const mode = readMode(process.env, path.join(__dirname, '..', 'staging-run', 'request.txt'));
    console.log('mode=' + mode);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'mode=' + mode + '\n');
  } catch (e) { console.error(e.message); process.exit(1); }
}
