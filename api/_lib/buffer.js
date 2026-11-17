'use strict';

// Buffer GraphQL client (server side only). The token never leaves the server.
// Hard rule enforced here, not just in the UI: the draft path (draftInput / createDraft) can only create DRAFTS and refuses any input that
// would schedule or publish. A separate, opt-in path (scheduleInput / createScheduled) can create a post scheduled for a FUTURE time
// (mode customScheduled with dueAt, at least 2 minutes ahead). It refuses shareNow, shareNext, the queue and recommended times, so nothing
// can be posted straight away. A post is only ever scheduled after an admin confirms the exact time on the /post page.
//
// Checked against Buffer's API reference (https://developers.buffer.com/reference.html), the create-draft example and the
// error-handling and hosting-media guides on 2026-11-15: createPost(input: CreatePostInput!) with saveToDraft, schedulingType
// and mode; post(input: PostInput!{id}); Post.assets is the Asset interface (type, mimeType, source, thumbnail); PostStatus has
// `draft`; GraphQL always answers HTTP 200 and system errors carry extensions.code. `npm run buffer:check` re-checks the live
// schema without changing anything. Every query lives in QUERIES below so any future change is one edit.

const { getConfig } = require('./config');

const ASSET_FIELDS = 'assets { __typename type mimeType source thumbnail }';

const QUERIES = {
  createDraft: 'mutation CreateDraft($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id text status channelId dueAt sentAt ' + ASSET_FIELDS + ' } } ... on MutationError { message } } }',
  readPost: 'query ReadPost($input: PostInput!) { post(input: $input) { id text status channelId dueAt sentAt ' + ASSET_FIELDS + ' } }',
  deleteDraft: 'mutation DeleteDraft($input: DeletePostInput!) { deletePost(input: $input) { __typename ... on DeletePostSuccess { id } ... on MutationError { message } } }',
  channels: 'query Channels($input: ChannelsInput!) { channels(input: $input) { id name service type isDisconnected isLocked } }',
};

// kind: permanent (do not retry) | safe (the request never reached Buffer or was refused, safe to repeat) |
//       ambiguous (it may have been processed: do NOT blindly repeat a create)
class BufferError extends Error {
  constructor(kind, message, detail) { super(message); this.kind = kind; this.detail = detail || null; }
}

const REFUSED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

async function gql(query, variables) {
  const cfg = getConfig().buffer;
  if (!cfg.token) throw new BufferError('permanent', 'Buffer is not configured (BUFFER_API_TOKEN is not set).');
  let res;
  try {
    res = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    const c = e && e.cause;
    const codes = [c && c.code].concat((c && c.errors || []).map((x) => x.code));
    const hit = codes.find((x) => REFUSED.has(x)) || ((String(c && c.message || '').match(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/) || [])[0]);
    if (hit) throw new BufferError('safe', 'Could not reach Buffer (' + hit + ').');
    throw new BufferError('ambiguous', 'The connection to Buffer failed after the request was sent.');
  }
  if (res.status === 401 || res.status === 403) throw new BufferError('permanent', 'Buffer refused the API token (' + res.status + '). Check BUFFER_API_TOKEN.');
  if (res.status === 429) throw retryAfter(new BufferError('safe', 'Buffer rate limit reached.'), res.headers.get('retry-after'));
  if (res.status >= 500) throw new BufferError('ambiguous', 'Buffer returned an error (' + res.status + ') and may or may not have processed the request.');
  let body;
  try { body = await res.json(); } catch (_) { throw new BufferError('ambiguous', 'Buffer sent a reply that could not be read.'); }
  // Buffer always answers HTTP 200. System errors are in `errors` with extensions.code. A reply that also carries usable data
  // (for example a created post plus a warning) is treated as a success.
  const hasData = body.data && Object.keys(body.data).some((k) => body.data[k] !== null && body.data[k] !== undefined);
  if (body.errors && body.errors.length && !hasData) throw fromGraphqlError(body.errors);
  if (!res.ok) throw new BufferError('permanent', 'Buffer returned ' + res.status + '.');
  return body.data;
}

function retryAfter(err, header) {
  const ra = Number(header);
  if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, 5000);
  return err;
}

// Maps Buffer's documented error codes to what is safe to do next.
function fromGraphqlError(errors) {
  const first = errors[0] || {};
  const code = first.extensions && first.extensions.code;
  const msg = errors.map((x) => x.message).join('; ');
  // Buffer's guide documents UNAUTHORIZED; the live API was observed answering UNAUTHENTICATED (HTTP 401) for a bad key.
  if (code === 'UNAUTHORIZED' || code === 'UNAUTHENTICATED' || code === 'FORBIDDEN') return new BufferError('permanent', 'Buffer refused the API token (' + code + '). Check BUFFER_API_TOKEN.', errors);
  if (code === 'NOT_FOUND') return new BufferError('permanent', 'Buffer could not find that item (NOT_FOUND).', errors);
  if (code === 'RATE_LIMIT_EXCEEDED') return new BufferError('safe', 'Buffer rate limit reached (RATE_LIMIT_EXCEEDED).', errors); // refused, not processed
  if (code === 'UNEXPECTED') return new BufferError('ambiguous', 'Buffer had a server error (UNEXPECTED) and may or may not have processed the request.', errors);
  return new BufferError('permanent', 'Buffer rejected the request: ' + msg, errors); // validation and schema errors: refused before running
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries only what is safe. `retryAmbiguous` is for read-only calls.
async function withRetries(fn, retryAmbiguous) {
  const delays = getConfig().buffer.retryDelaysMs;
  let attempt = 0;
  for (;;) {
    try { return await fn(); } catch (e) {
      const retryable = e instanceof BufferError && (e.kind === 'safe' || (retryAmbiguous && e.kind === 'ambiguous'));
      if (!retryable || attempt >= delays.length) throw e;
      const jitter = Math.floor(Math.random() * 100);
      await sleep((e.retryAfterMs || delays[attempt]) + jitter);
      attempt++;
    }
  }
}

// The only way to build a create-post input in this codebase.
function draftInput({ channelId, text, imageUrls, altTexts }) {
  const input = {
    channelId, text,
    schedulingType: 'automatic',
    mode: 'addToQueue',
    saveToDraft: true,
    assets: (imageUrls || []).map((url, i) => ({ image: { url, metadata: { altText: (altTexts && altTexts[i]) || '' } } })),
  };
  assertDraftOnly(input);
  return input;
}

function assertDraftOnly(input) {
  if (!input || input.saveToDraft !== true) throw new Error('Refusing to call Buffer: saveToDraft must be true.');
  if (input.dueAt) throw new Error('Refusing to call Buffer: a draft must not have a scheduled time.');
  if (input.mode && input.mode !== 'addToQueue') throw new Error('Refusing to call Buffer: mode ' + input.mode + ' could publish or schedule.');
  if (!/^[a-f0-9]{24}$/i.test(String(input.channelId || ''))) throw new Error('Refusing to call Buffer: bad channel id.');
}

// Scheduled posts: a fixed future time, never "now" or "next in the queue".
const MIN_AHEAD_MS = 2 * 60 * 1000, MAX_AHEAD_MS = 366 * 24 * 3600 * 1000;
function scheduleInput({ channelId, text, imageUrls, altTexts, dueAt }) {
  const input = {
    channelId, text,
    schedulingType: 'automatic',
    mode: 'customScheduled',
    saveToDraft: false,
    dueAt,
    assets: (imageUrls || []).map((url, i) => ({ image: { url, metadata: { altText: (altTexts && altTexts[i]) || '' } } })),
  };
  assertScheduleOnly(input);
  return input;
}

function assertScheduleOnly(input) {
  if (!input || input.saveToDraft !== false) throw new Error('Refusing to schedule: saveToDraft must be false for a scheduled post.');
  if (input.mode !== 'customScheduled') throw new Error('Refusing to schedule: mode ' + input.mode + ' could post straight away. Only customScheduled is allowed.');
  if (typeof input.dueAt !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(input.dueAt)) throw new Error('Refusing to schedule: dueAt must be a UTC time like 2027-01-31T09:00:00.000Z.');
  const ahead = new Date(input.dueAt).getTime() - Date.now();
  if (!(ahead >= MIN_AHEAD_MS)) throw new Error('Refusing to schedule: the time must be at least 2 minutes in the future.');
  if (ahead > MAX_AHEAD_MS) throw new Error('Refusing to schedule: more than a year ahead.');
  if (!/^[a-f0-9]{24}$/i.test(String(input.channelId || ''))) throw new Error('Refusing to call Buffer: bad channel id.');
}

async function createDraft(input) {
  assertDraftOnly(input);
  return createPost(input);
}
async function createScheduled(input) {
  assertScheduleOnly(input);
  return createPost(input);
}
async function createPost(input) {
  const data = await withRetries(() => gql(QUERIES.createDraft, { input }), false);
  const r = data && data.createPost;
  if (!r) throw new BufferError('ambiguous', 'Buffer did not say whether the draft was created.');
  if (!r.post || !r.post.id) {
    // Any typed error (InvalidInputError, LimitReachedError, ...) implements MutationError and carries a message.
    if (r.message) throw new BufferError('permanent', 'Buffer would not save the draft: ' + r.message);
    throw new BufferError('ambiguous', 'Buffer reply had no post id.');
  }
  return r.post;
}

async function readPost(id) {
  const data = await withRetries(() => gql(QUERIES.readPost, { input: { id } }), true);
  if (!data || !data.post) throw new BufferError('permanent', 'Buffer has no post with that id.');
  return data.post;
}

const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').trim();

// Compares what Buffer actually stored with what we meant to send.
function verifyDraft(post, expected) {
  const problems = [];
  if (post.status !== 'draft') problems.push('Buffer status is "' + post.status + '", expected "draft".');
  if (post.dueAt) problems.push('The post has a scheduled time. It must not.');
  if (post.sentAt) problems.push('The post shows as sent.');
  if (expected.channelId && post.channelId && post.channelId !== expected.channelId) problems.push('The post is on a different channel.');
  if (norm(post.text) !== norm(expected.text)) problems.push('The saved caption differs from the approved caption.');
  const assets = (post.assets || []).filter((a) => !a.type || String(a.type).toLowerCase() === 'image');
  if (assets.length !== expected.imageUrls.length) problems.push('Buffer saved ' + assets.length + ' image(s), expected ' + expected.imageUrls.length + '.');
  else assets.forEach((a, i) => { if (a.source !== expected.imageUrls[i]) problems.push('Image ' + (i + 1) + ' in Buffer is not the approved image.'); });
  return { ok: problems.length === 0, problems };
}

// Read-back for a scheduled post: Buffer must hold it as "scheduled" for the time we meant, not sent, not sending, not a draft.
function verifyScheduled(post, expected) {
  const problems = [];
  if (post.status !== 'scheduled') problems.push('Buffer status is "' + post.status + '", expected "scheduled".');
  if (post.sentAt) problems.push('The post shows as sent.');
  const got = post.dueAt ? new Date(post.dueAt).getTime() : NaN;
  if (!Number.isFinite(got) || Math.abs(got - new Date(expected.dueAt).getTime()) > 60 * 1000) problems.push('The scheduled time in Buffer (' + (post.dueAt || 'none') + ') is not the time that was confirmed (' + expected.dueAt + ').');
  const base = verifyDraft(Object.assign({}, post, { status: 'draft', dueAt: null, sentAt: null }), expected);
  base.problems.forEach((p) => problems.push(p));
  return { ok: problems.length === 0, problems };
}

// ONLY for the staging end-to-end test, to remove the throw-away draft it created. Deliberately narrow: it refuses unless the
// post is still a draft, is on the expected channel, has no schedule or sent time, and its text contains the unique marker of
// this test run. It is not used by the website, and the draft-creation path above still cannot publish or schedule.
async function deleteTestDraft(id, expect) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) throw new BufferError('permanent', 'Not a Buffer post id.');
  if (!expect || !expect.marker || String(expect.marker).length < 8 || !expect.channelId) throw new Error('Refusing to delete: a unique test marker and the channel are required.');
  const post = await readPost(id);
  if (post.status !== 'draft' || post.dueAt || post.sentAt) throw new BufferError('permanent', 'Refusing to delete: the post is not an unscheduled draft.');
  if (post.channelId !== expect.channelId) throw new BufferError('permanent', 'Refusing to delete: the post is on a different channel.');
  if (!String(post.text || '').includes(expect.marker)) throw new BufferError('permanent', 'Refusing to delete: the post does not carry this test run\'s marker.');
  const data = await withRetries(() => gql(QUERIES.deleteDraft, { input: { id } }), false);
  const r = data && data.deletePost;
  if (!r || !r.id) throw new BufferError(r && r.message ? 'permanent' : 'ambiguous', r && r.message ? 'Buffer would not delete the draft: ' + r.message : 'Buffer did not confirm the deletion.');
  // Confirm it is really gone (the API answers NOT_FOUND for a deleted post).
  try { await readPost(id); } catch (e) { if (e instanceof BufferError && e.kind === 'permanent') return true; throw e; }
  throw new BufferError('ambiguous', 'Buffer said the draft was deleted but it can still be read.');
}

async function listChannels(organizationId) {
  const data = await withRetries(() => gql(QUERIES.channels, { input: { organizationId } }), true);
  return data.channels;
}

module.exports = { scheduleInput, assertScheduleOnly, createScheduled, verifyScheduled, deleteTestDraft, fromGraphqlError, QUERIES, BufferError, draftInput, assertDraftOnly, createDraft, readPost, verifyDraft, listChannels, gql };
