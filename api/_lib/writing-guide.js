'use strict';

// The JNR writing guide: the plain-English voice instructions and a few example posts that the AI caption writer is given with every request.
// It is an editable setting (admin and editors can change it in the dashboard, no code needed); every save is kept as a version so a bad
// edit can be rolled back. If nobody has saved one yet, the first version below is used.
//
// Nothing in it is a fact about a real customer or job. The sample posts are STRUCTURES with [placeholders], labelled as samples; real
// published posts can later be added as examples ("use as a style example").

const { query, tx } = require('./db');
const { audit } = require('./auth');
const { HttpError } = require('./http');
const { scanPublicText } = require('./confidential');
const M = require('./model');

const KEY = 'writing_guide';
const LIMITS = { style: 4000, line: 600, name: 60, blurb: 300, signOff: 300, neverSay: 30, neverSayEach: 200, examples: 12, exampleTitle: 80, exampleText: 1200, brands: 6 };

const DEFAULT_GUIDE = {
  brands: [
    { id: 'jnr', name: 'J.N.R. Engineering', note: '' },
    { id: 'marpet', name: 'Marpet', note: 'Marpet is a fabrication company and the sister company of J.N.R. Engineering.' },
  ],
  style:
    'You are writing a LinkedIn post for John, who posts for the workshop. It is for a business audience: customers, other makers, suppliers and people who like seeing well-made things.\n' +
    'Sound like John talking to a friend: friendly, chatty, plain and practical. Be proud of the work without boasting: let the job itself show how good it is. Never use marketing language, buzzwords or exclamation-mark hype.\n' +
    'Write as "we" (the workshop) unless the post is clearly about one person.\n' +
    'Explain what the job was and what it was for, then what we did, using only what is in the job notes. If the notes say why it mattered, say so; if they do not, do not make up a reason.\n' +
    'Use British spelling and millimetres (mm) for sizes. Keep sentences short.',
  length: 'One short paragraph, roughly 40 to 80 words. No headings, no bullet points.',
  emoji: 'Do not use emoji, unless the job notes ask for one.',
  hashtags: 'Do not use hashtags.',
  customers: 'Do not name the customer. If the job notes say who the work was for in general terms, you may use those words. If they do not, say "a customer", or describe what the part is for. Only use a customer\'s name when the request says naming them is allowed.',
  photos: 'If photo descriptions are supplied, mention what the photos show in a natural way, then let the photos speak for themselves. If none are supplied, a short line like "Photos below." is fine. Never describe what a photo shows unless it was described.',
  sign_off: { text: '', use_by_default: false },
  never_say: [
    'Do not mention where the workshop is.',
    'Do not mention prices, costs, lead times or delivery dates, and do not promise anything.',
    'Do not claim to be the best, cheapest, fastest, leading, or "number one", and do not mention competitors.',
    'Do not add any fact that is not in the job notes: no numbers, sizes, tolerances, materials, machines, processes, customers, quantities, outcomes or reasons that were not supplied.',
  ],
  examples: [
    {
      id: 'sample-1', source: 'sample', title: 'SAMPLE structure: a part for a customer',
      text: 'SAMPLE (a structure only, not a real post, not a real job): This one was [the part] for [who it is for, in general words, or what it is used on]. We made it from [material] using [process], and [one practical detail from the notes]. The photos show [what the photos show, only if described]. [One sentence on why it mattered, only if the notes say so.]',
    },
    {
      id: 'sample-2', source: 'sample', title: 'SAMPLE structure: busy week',
      text: 'SAMPLE (a structure only, not a real post, not a real job): Busy week in the workshop. [What was made] is finished and ready to go. [One practical detail from the notes.] Photos below.',
    },
    {
      id: 'sample-3', source: 'sample', title: 'SAMPLE structure: a tricky one',
      text: 'SAMPLE (a structure only, not a real post, not a real job): A bit of a puzzle this week: [the problem, in the notes\' words]. Here is how we tackled it: [what was done, in the notes\' words]. [How it turned out, only if the notes say so.]',
    },
  ],
};

function clean(v, max, label) {
  const s = M.clean(v);
  if (s.length > max) throw new HttpError(422, 'validation', label + ' is too long (' + max + ' characters at most).');
  return s;
}

// Everything that will be sent to the AI is checked like public text: a customer's email, phone number or a purchase order in the guide
// would otherwise travel with every request.
function assertNoConfidentialText(text, label) {
  const scan = scanPublicText({ summary: text });
  if (scan.blocking.length) throw new HttpError(422, 'confidential', label + ' contains something that must not be sent to the AI (' + scan.blocking.map((b) => b.code).join(', ').replace(/_/g, ' ') + '). Take it out.');
}

function validate(input) {
  const g = input || {};
  const out = {};
  out.brands = (Array.isArray(g.brands) ? g.brands : []).slice(0, LIMITS.brands).map((b, i) => ({
    id: M.clean(b && b.id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'brand-' + (i + 1),
    name: clean(b && b.name, LIMITS.name, 'A company name'), note: clean(b && b.note, LIMITS.blurb, 'A company note'),
  })).filter((b) => b.name);
  if (!out.brands.length) throw new HttpError(422, 'validation', 'Add at least one company name to post as.');
  out.style = clean(g.style, LIMITS.style, 'The voice and style');
  if (out.style.length < 20) throw new HttpError(422, 'validation', 'Describe the voice and style in a few sentences.');
  for (const k of ['length', 'emoji', 'hashtags', 'customers', 'photos']) out[k] = clean(g[k], LIMITS.line, 'The "' + k + '" line');
  const so = g.sign_off || {};
  out.sign_off = { text: clean(so.text, LIMITS.signOff, 'The sign-off'), use_by_default: so.use_by_default === true };
  out.never_say = (Array.isArray(g.never_say) ? g.never_say : []).slice(0, LIMITS.neverSay).map((s) => clean(s, LIMITS.neverSayEach, 'A "never say" line')).filter(Boolean);
  out.examples = (Array.isArray(g.examples) ? g.examples : []).slice(0, LIMITS.examples).map((e, i) => ({
    id: M.clean(e && e.id).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || 'example-' + (i + 1),
    source: e && e.source === 'published' ? 'published' : 'sample',
    title: clean(e && e.title, LIMITS.exampleTitle, 'An example title'),
    text: clean(e && e.text, LIMITS.exampleText, 'An example'),
    entry_id: e && e.source === 'published' && /^[0-9a-f-]{36}$/i.test(String(e.entry_id || '')) ? String(e.entry_id) : undefined,
  })).filter((e) => e.text);
  for (const k of ['style', 'length', 'emoji', 'hashtags', 'customers', 'photos']) assertNoConfidentialText(out[k], 'The "' + k + '" text');
  assertNoConfidentialText(out.sign_off.text, 'The sign-off');
  out.brands.forEach((b) => assertNoConfidentialText(b.name + ' ' + b.note, 'The company "' + b.name + '"'));
  out.never_say.forEach((s) => assertNoConfidentialText(s, 'A "never say" line'));
  out.examples.forEach((e) => assertNoConfidentialText(e.text, 'The example "' + e.title + '"'));
  return out;
}

async function getGuide() {
  const { rows } = await query('select value, version, updated_at from settings where key = $1', [KEY]);
  if (!rows[0]) return { guide: JSON.parse(JSON.stringify(DEFAULT_GUIDE)), version: 0, saved: false };
  return { guide: Object.assign(JSON.parse(JSON.stringify(DEFAULT_GUIDE)), rows[0].value), version: rows[0].version, saved: true, updated_at: rows[0].updated_at };
}

async function saveGuide(user, input) {
  const value = validate(input);
  return tx(async (client) => {
    const cur = (await client.query('select version from settings where key = $1 for update', [KEY])).rows[0];
    if (input && input.version !== undefined && Number(input.version) !== (cur ? cur.version : 0)) {
      throw new HttpError(409, 'conflict', 'Someone else changed the writing guide. Reload it to see their changes.');
    }
    const version = (cur ? cur.version : 0) + 1;
    await client.query('insert into settings (key, value, version, updated_by) values ($1,$2,$3,$4) on conflict (key) do update set value = excluded.value, version = excluded.version, updated_by = excluded.updated_by, updated_at = now()', [KEY, JSON.stringify(value), version, user.id]);
    await client.query('insert into settings_history (key, version, value, updated_by) values ($1,$2,$3,$4)', [KEY, version, JSON.stringify(value), user.id]);
    await audit(client, user, 'writing_guide_updated', null, { version });
    return { guide: value, version, saved: true };
  });
}

async function guideHistory(limit) {
  const { rows } = await query('select h.version, h.updated_at, u.email as updated_by from settings_history h left join users u on u.id = h.updated_by where h.key = $1 order by h.version desc limit $2', [KEY, Math.min(Number(limit) || 20, 50)]);
  return rows;
}

// Puts an earlier version back as a NEW version (history is never rewritten).
async function restoreVersion(user, version) {
  const { rows } = await query('select value from settings_history where key = $1 and version = $2', [KEY, Number(version)]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'That version of the writing guide does not exist.');
  return saveGuide(user, rows[0].value);
}

// A published post that turned out well can be kept as a style example, so the guide improves from real JNR posts over time.
// Uses the approved caption text only (never notes, names or anything private). The oldest example of the same kind is dropped when full.
async function addPublishedExample(user, entryId) {
  const { rows } = await query('select id, title, live_snapshot from entries where id = $1', [entryId]);
  const entry = rows[0];
  if (!entry) throw new HttpError(404, 'not_found', 'Entry not found.');
  const snap = entry.live_snapshot;
  const text = snap && snap.caption ? String(snap.caption).trim() : '';
  if (!text) throw new HttpError(409, 'bad_transition', 'Only a published entry with an approved caption can be used as a style example.');
  const cur = await getGuide();
  const guide = JSON.parse(JSON.stringify(cur.guide));
  if (guide.examples.some((e) => e.entry_id === entryId)) return { guide, version: cur.version, already: true };
  const mine = guide.examples.filter((e) => e.source === 'published');
  const sample = guide.examples.filter((e) => e.source === 'sample');
  mine.push({ id: 'post-' + entryId.slice(0, 8), source: 'published', title: String(snap.title || entry.title).slice(0, LIMITS.exampleTitle), text: text.slice(0, LIMITS.exampleText), entry_id: entryId });
  // keep room: real posts first, samples fill the rest
  guide.examples = mine.slice(-LIMITS.examples).concat(sample).slice(0, LIMITS.examples);
  return saveGuide(user, Object.assign({}, guide, { version: cur.version }));
}

// What goes into the AI request: real examples first, then samples, at most `n` in total (cost control).
function examplesForPrompt(guide, n) {
  const ex = guide.examples || [];
  return ex.filter((e) => e.source === 'published').concat(ex.filter((e) => e.source !== 'published')).slice(0, n || 3);
}

module.exports = { DEFAULT_GUIDE, LIMITS, validate, getGuide, saveGuide, guideHistory, restoreVersion, addPublishedExample, examplesForPrompt, KEY };
