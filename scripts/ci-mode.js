'use strict';
// Decides which staging run the GitHub Action should do, from the TAG that started it. The mode is part of the tag name and the
// tag must point at the commit its name says, so a run cannot be redirected by editing any file. Code always comes from the
// tagged commit, never from a branch.
//   tag format:  staging-<mode>-<first 7 characters of the commit SHA>     e.g. staging-services-4373cab
const MODES = ['services', 'check', 'e2e', 'e2e-draft'];
const TAG = /^staging-(services|check|e2e-draft|e2e)-([0-9a-f]{7})$/;

function readMode(env) {
  if (env.GITHUB_REF_TYPE !== 'tag') throw new Error('Staging runs start only from an approved tag, never from a branch.');
  const m = TAG.exec(String(env.GITHUB_REF_NAME || ''));
  if (!m) throw new Error('The tag name must look like staging-<mode>-<7 character commit>, with mode one of: ' + MODES.join(', ') + '.');
  const sha = String(env.GITHUB_SHA || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('No commit SHA available.');
  if (sha.slice(0, 7) !== m[2]) throw new Error('The tag name says commit ' + m[2] + ' but the tag points at ' + sha.slice(0, 7) + '. Refusing.');
  return m[1];
}

module.exports = { readMode, MODES, TAG };
if (require.main === module) {
  try {
    const mode = readMode(process.env);
    console.log('mode=' + mode);
    if (process.env.GITHUB_OUTPUT) require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, 'mode=' + mode + '\n');
  } catch (e) { console.error(e.message); process.exit(1); }
}
