'use strict';

// OPTIONAL, READ-ONLY, OFF BY DEFAULT. See docs/TOLRA-INTEGRATION.md.
// The only thing this site ever wants from Tolra is the production stage of a job, looked up by job reference.
// Design rules: no direct database or ERP connection, a dedicated read-only endpoint on the Tolra side that already
// returns only the allowed fields, an allow-list mapping here, and nothing from Tolra is stored except the stage
// suggestion that a person then accepts. Customer names, prices, drawings and notes are never requested.

const { getConfig } = require('./config');
const { STAGES } = require('./model');

// Tolra's own status words -> our stages. Anything not listed is ignored, not guessed.
const STAGE_MAP = {
  'material received': 'materials_in', 'programming': 'programming', 'set up': 'setup', 'setup': 'setup',
  'machining': 'machining', 'fabrication': 'fabrication', 'finishing': 'finishing', 'inspection': 'inspection',
  'ready': 'ready', 'complete': 'ready', 'despatched': 'delivered', 'delivered': 'delivered',
};

function enabled() { const t = getConfig().tolra; return !!(t.enabled && t.url && t.token); }

// Returns { stage } or null. Never throws into the request: Tolra being down must not stop anyone using the form.
async function suggestStage(jobRef, fetchImpl) {
  if (!enabled() || !/^[A-Za-z0-9._-]{2,40}$/.test(String(jobRef || ''))) return null;
  const t = getConfig().tolra;
  try {
    const res = await (fetchImpl || fetch)(t.url.replace(/\/$/, '') + '/jobs/' + encodeURIComponent(jobRef) + '/stage', {
      method: 'GET', headers: { authorization: 'Bearer ' + t.token, accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const body = await res.json();
    const stage = STAGE_MAP[String(body && body.status || '').toLowerCase().trim()];
    return stage && STAGES.includes(stage) ? { stage } : null; // everything else in the reply is dropped here
  } catch (_) { return null; }
}

module.exports = { suggestStage, enabled, STAGE_MAP };
