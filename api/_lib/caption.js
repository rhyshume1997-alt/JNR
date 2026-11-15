'use strict';

// LinkedIn caption generation. Two providers:
//   template  free, offline, deterministic. The default.
//   anthropic paid API, only when AI_CAPTIONS_ENABLED=true and a key is set.
// Both go through validateCaption(): numbers, names and claims that are not in the job facts are rejected,
// and a rejected AI caption falls back to the template. Nothing is invented, by construction.

const background = require('../../content/background.json');
const { getConfig } = require('./config');
const { STAGE_LABELS, KIND_LABELS } = require('./model');

const MAX_LEN = 700;

function factsOf(entry) {
  return {
    kind: entry.kind,
    kindLabel: KIND_LABELS[entry.kind],
    title: entry.title || '',
    summary: entry.summary || '',
    material: entry.material || '',
    process: entry.process || '',
    stage: entry.stage || null,
    stageLabel: entry.stage ? STAGE_LABELS[entry.stage] : '',
  };
}

function sentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : t + '.';
}

function hashtags(process) {
  const p = String(process || '').toLowerCase();
  const tags = [];
  if (/\bmill/.test(p)) tags.push('#CNCMilling');
  if (/\bturn/.test(p)) tags.push('#CNCTurning');
  if (/water\s*-?jet/.test(p)) tags.push('#WaterJet');
  if (/fabricat|weld/.test(p)) tags.push('#Fabrication');
  return tags.slice(0, 3);
}

function templateCaption(facts) {
  const lines = [];
  if (facts.kind === 'completed') lines.push('Completed: ' + facts.title.replace(/[.!?]+$/, '') + '.');
  else if (facts.kind === 'in_production') lines.push('In production at J.N.R.: ' + facts.title.replace(/[.!?]+$/, '') + '.');
  else lines.push('From the workshop: ' + facts.title.replace(/[.!?]+$/, '') + '.');
  lines.push('');
  lines.push(sentence(facts.summary));
  const spec = [];
  if (facts.material) spec.push('Material: ' + facts.material.replace(/[.]+$/, '') + '.');
  if (facts.process) spec.push('Process: ' + facts.process.replace(/[.]+$/, '') + '.');
  if (facts.kind === 'in_production' && facts.stageLabel) spec.push('Current stage: ' + facts.stageLabel + '.');
  if (spec.length) { lines.push(''); lines.push(spec.join(' ')); }
  lines.push('');
  lines.push('J.N.R. Engineering, Hamilton.');
  if (facts.kind !== 'in_production') lines.push('Got a part to make? ' + background.siteHost + '/quote');
  const tags = hashtags(facts.process);
  if (tags.length) { lines.push(''); lines.push(tags.join(' ')); }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Words and numbers that came from the job itself.
function factText(facts) { return [facts.title, facts.summary, facts.material, facts.process, facts.stageLabel].join(' ').toLowerCase(); }
function wordsOf(text) { return new Set((String(text).toLowerCase().match(/[a-z][a-z'’.-]*[a-z]|[a-z]/g) || [])); }

const CLAIM_PATTERNS = [
  /\bguarantee[sd]?\b/i, /\bcertified\b/i, /\baccredited\b/i, /\biso\s*\d+/i, /\baward[- ]?winning\b/i, /\bbest\b/i,
  /\bleading\b/i, /\bfastest\b/i, /\bsame[- ]day\b/i, /\bnext[- ]day\b/i, /\blead[- ]times?\b/i, /\bwithin\s+\d+/i,
  /\bon[- ]time\b/i, /\bahead of schedule\b/i, /\btolerances?\b/i, /±/, /\bpassed\b/i, /\bsuccessful(?:ly)?\b/i,
  /\bdelivered\b/i, /\bshipped\b/i, /\bon schedule\b/i, /\bsaved\b/i, /\bfor (?:a )?(?:major|leading|well[- ]known)\b/i,
];

function validateCaption(caption, facts, forbidden) {
  const problems = [];
  const text = String(caption || '').trim();
  if (!text) return { ok: false, problems: ['Caption is empty.'] };
  if (text.length > MAX_LEN) problems.push('Caption is longer than ' + MAX_LEN + ' characters.');
  if (/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) problems.push('Contains an emoji.');
  if (/!/.test(text) && !/!/.test(factText(facts))) problems.push('Contains an exclamation mark.');

  const ft = factText(facts);
  const allowedNumbers = new Set(ft.match(/\d+(?:[.,]\d+)?/g) || []);
  (text.match(/\d+(?:[.,]\d+)?/g) || []).forEach(function (n) {
    if (!allowedNumbers.has(n)) problems.push('Contains a number that is not in the job details: ' + n);
  });

  CLAIM_PATTERNS.forEach(function (re) {
    const m = text.match(re);
    if (m && !re.test(ft)) problems.push('Makes a claim that is not in the job details: "' + m[0] + '"');
  });

  const urls = text.match(/\b[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/gi) || [];
  urls.forEach(function (u) {
    if (/^j\.n\.r\.?$/i.test(u)) return;
    if (u.toLowerCase().indexOf(background.siteHost) !== 0 && ft.indexOf(u.toLowerCase()) === -1) problems.push('Contains a link or address that is not ours: ' + u);
  });

  // Capitalised words mid-sentence must come from the job, the company background, or ordinary template words.
  const known = new Set();
  wordsOf(ft).forEach((w) => known.add(w));
  wordsOf(background.name + ' ' + background.place + ' ' + background.statements.join(' ')).forEach((w) => known.add(w));
  ['j.n.r', 'j.n.r.', 'cnc', 'uk'].forEach((w) => known.add(w));
  const proper = [];
  const tokens = text.split(/(\s+)/);
  let prevEnds = true;
  tokens.forEach(function (tok) {
    if (/^\s+$/.test(tok)) { if (/\n/.test(tok)) prevEnds = true; return; }
    const word = tok.replace(/^[("']+|[)"',;:.!?]+$/g, '');
    if (/^#/.test(tok)) { prevEnds = false; return; }
    if (/^[A-Z][A-Za-z'’-]{2,}$/.test(word) && !prevEnds && !known.has(word.toLowerCase())) proper.push(word);
    prevEnds = /[.!?:]$/.test(tok);
  });
  proper.forEach(function (w) { problems.push('Contains a name or term that is not in the job details: ' + w); });

  (forbidden || []).filter(Boolean).forEach(function (f) {
    if (String(f).length >= 3 && text.toLowerCase().includes(String(f).toLowerCase())) problems.push('Contains private information.');
  });
  return { ok: problems.length === 0, problems };
}

function aiPrompt(facts) {
  const system = [
    'You write short LinkedIn posts for J.N.R. Engineering, a family run machining and fabrication workshop in Hamilton, Scotland.',
    'Voice: ' + background.voice,
    'Hard rules:',
    '- Use ONLY the job facts and company background supplied. Do not add any specification, tolerance, quantity, customer, industry, outcome, date, location detail or lead time that is not in them.',
    '- Never name a customer. Never mention drawings or part numbers.',
    '- Do not claim certifications, awards, speed or quality that are not supplied.',
    '- 2 to 4 short sentences, under 600 characters, British spelling, no emojis, no exclamation marks, no hashtags except optional #CNCMilling, #CNCTurning, #WaterJet, #Fabrication when the process matches.',
    '- Output the post text only.',
  ].join('\n');
  const user = 'Job facts (JSON):\n' + JSON.stringify({
    type: facts.kindLabel, title: facts.title, description: facts.summary, material: facts.material || undefined,
    process: facts.process || undefined, current_stage: facts.stageLabel || undefined,
  }) + '\n\nCompany background:\n' + background.statements.join('\n') + '\n\nWrite the post.';
  return { system, user };
}

async function callAnthropic(cfg, facts, fetchImpl) {
  const p = aiPrompt(facts);
  const res = await (fetchImpl || fetch)(cfg.apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.model, max_tokens: 400, system: p.system, messages: [{ role: 'user', content: p.user }] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Caption service returned ' + res.status);
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'text');
  if (!block || !block.text) throw new Error('Caption service returned no text');
  return block.text.trim();
}

// Returns { caption, source: 'template'|'ai', note? }. Never throws for provider problems: it falls back.
async function generateCaption(entry, opts) {
  const cfg = getConfig().caption;
  const facts = factsOf(entry);
  const forbidden = [entry.customer_name, entry.job_ref];
  const fallback = function (note) {
    const t = templateCaption(facts);
    const v = validateCaption(t, facts, forbidden);
    return { caption: t, source: 'template', note: note || undefined, problems: v.ok ? undefined : v.problems };
  };
  const wantAi = (opts && opts.provider) ? opts.provider === 'ai' : cfg.aiEnabled;
  if (!wantAi) return fallback();
  if (!cfg.apiKey) return fallback('AI captions are switched on but no key is set, so the template was used.');
  try {
    const text = await callAnthropic(cfg, facts, opts && opts.fetchImpl);
    const v = validateCaption(text, facts, forbidden);
    if (!v.ok) return fallback('The AI caption was rejected (' + v.problems[0] + ') so the template was used.');
    return { caption: text, source: 'ai' };
  } catch (e) {
    return fallback('The caption service was not available, so the template was used.');
  }
}

module.exports = { factsOf, templateCaption, validateCaption, generateCaption, aiPrompt, MAX_LEN };
