'use strict';

// Buffer GraphQL client (server side only). The token never leaves the server.
// Hard rule enforced here, not just in the UI: this module can only create DRAFTS. It refuses any input that would
// schedule or publish, so a bug elsewhere cannot post to LinkedIn.
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
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return new BufferError('permanent', 'Buffer refused the API token (' + code + '). Check BUFFER_API_TOKEN.', errors);
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

async function createDraft(input) {
  assertDraftOnly(input);
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

async function listChannels(organizationId) {
  const data = await withRetries(() => gql(QUERIES.channels, { input: { organizationId } }), true);
  return data.channels;
}

module.exports = { QUERIES, BufferError, draftInput, assertDraftOnly, createDraft, readPost, verifyDraft, listChannels, gql };
