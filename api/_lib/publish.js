'use strict';

const crypto = require('node:crypto');
const { query, tx } = require('./db');
const { audit } = require('./auth');
const { HttpError } = require('./http');
const { getConfig, linkedinChannel } = require('./config');
const E = require('./entries');
const buffer = require('./buffer');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function getSnapshotRow(id, client) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q('select id, status, version, approved_snapshot, live_snapshot from entries where id = $1' + (client ? ' for update' : ''), [id]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Entry not found.');
  return rows[0];
}

async function upsertPublication(destination, entryId, channelId, hash) {
  const key = entryId + ':' + destination + ':' + (channelId || 'site') + ':' + hash;
  await query('insert into publications (entry_id, destination, channel_id, content_hash, idempotency_key) values ($1,$2,$3,$4,$5) on conflict (idempotency_key) do nothing', [entryId, destination, channelId || null, hash, key]);
  return (await query('select * from publications where idempotency_key = $1', [key])).rows[0];
}

async function setPub(id, fields) {
  const cols = Object.keys(fields);
  await query('update publications set ' + cols.map((c, i) => c + ' = $' + (i + 2)).join(', ') + ', updated_at = now() where id = $1', [id].concat(cols.map((c) => fields[c])));
}

async function publishWebsite(user, entry) {
  const snap = entry.approved_snapshot;
  const hash = sha(JSON.stringify([snap.title, snap.summary, snap.body, snap.images.map((i) => i.url)]));
  const pub = await upsertPublication('website', entry.id, null, hash);
  await query('update entries set live_snapshot = approved_snapshot, live_at = now() where id = $1', [entry.id]);
  await setPub(pub.id, { status: 'verified', verified_at: new Date(), attempts: pub.attempts + 1, last_error: null });
  await audit(null, user, 'website_published', entry.id, { slug: snap.slug });
  return { destination: 'website', status: 'verified' };
}

async function verifyAndRecord(user, entry, pub, expected) {
  try {
    const post = await buffer.readPost(pub.buffer_post_id);
    const v = buffer.verifyDraft(post, expected);
    if (v.ok) {
      await setPub(pub.id, { status: 'verified', verified_at: new Date(), last_error: null });
      await audit(null, user, 'buffer_draft_verified', entry.id, { buffer_post_id: pub.buffer_post_id, images: expected.imageUrls.length });
      return { destination: 'linkedin', status: 'verified', buffer_post_id: pub.buffer_post_id };
    }
    await setPub(pub.id, { status: 'failed', last_error: 'Read-back check failed: ' + v.problems.join(' ') });
    await audit(null, user, 'buffer_verify_failed', entry.id, { buffer_post_id: pub.buffer_post_id, problems: v.problems });
    return { destination: 'linkedin', status: 'failed', error: v.problems.join(' '), buffer_post_id: pub.buffer_post_id };
  } catch (e) {
    const msg = e instanceof buffer.BufferError ? e.message : 'Could not read the draft back from Buffer.';
    await setPub(pub.id, { status: 'saved', last_error: 'Saved, but not yet verified: ' + msg });
    return { destination: 'linkedin', status: 'saved', error: msg, buffer_post_id: pub.buffer_post_id };
  }
}

async function publishLinkedIn(user, entry) {
  const snap = entry.approved_snapshot;
  let channelId;
  try { channelId = linkedinChannel(); } catch (e) { return { destination: 'linkedin', status: 'failed', error: e.message }; }
  const imageUrls = snap.images.map((i) => i.url);
  const altTexts = snap.images.map((i) => i.alt);
  const hash = sha(JSON.stringify([channelId, snap.caption, imageUrls]));
  const expected = { channelId, text: snap.caption, imageUrls };
  let pub = await upsertPublication('linkedin', entry.id, channelId, hash);

  if (pub.status === 'verified') return { destination: 'linkedin', status: 'verified', buffer_post_id: pub.buffer_post_id, unchanged: true };
  if (pub.status === 'saved' && pub.buffer_post_id) return verifyAndRecord(user, entry, pub, expected);
  if (pub.status === 'uncertain') return { destination: 'linkedin', status: 'uncertain', error: pub.last_error, publication_id: pub.id };
  if (pub.status === 'failed' && pub.buffer_post_id) return verifyAndRecord(user, entry, pub, expected);

  // Claim the right to send. Only one request can move pending/failed to sending.
  const claim = await query("update publications set status = 'sending', attempts = attempts + 1, updated_at = now() where id = $1 and (status in ('pending','failed') or (status = 'sending' and updated_at < now() - interval '3 minutes')) returning *", [pub.id]);
  if (!claim.rows[0]) throw new HttpError(409, 'in_progress', 'This is already being sent to Buffer. Check again in a moment.');
  if (pub.status === 'sending') {
    // A previous attempt died mid-send: we cannot know whether the draft exists.
    await setPub(pub.id, { status: 'uncertain', last_error: 'An earlier attempt stopped part way. Check Buffer for a draft with this caption before retrying.' });
    return { destination: 'linkedin', status: 'uncertain', error: 'An earlier attempt stopped part way.', publication_id: pub.id };
  }
  pub = claim.rows[0];
  await audit(null, user, 'buffer_draft_requested', entry.id, { channel_id: channelId, attempt: pub.attempts });
  try {
    const post = await buffer.createDraft(buffer.draftInput({ channelId, text: snap.caption, imageUrls, altTexts }));
    await setPub(pub.id, { status: 'saved', buffer_post_id: post.id, last_error: null });
    pub.buffer_post_id = post.id;
    await audit(null, user, 'buffer_draft_created', entry.id, { buffer_post_id: post.id });
    return verifyAndRecord(user, entry, pub, expected);
  } catch (e) {
    if (e instanceof buffer.BufferError && e.kind === 'ambiguous') {
      await setPub(pub.id, { status: 'uncertain', last_error: e.message + ' Check Buffer for a draft with this caption, then mark it found or retry.' });
      await audit(null, user, 'buffer_draft_uncertain', entry.id, { message: e.message });
      return { destination: 'linkedin', status: 'uncertain', error: e.message, publication_id: pub.id };
    }
    const msg = e instanceof buffer.BufferError ? e.message : 'Unexpected error talking to Buffer.';
    if (!(e instanceof buffer.BufferError)) console.error('Buffer publish error:', e && e.stack || e);
    await setPub(pub.id, { status: 'failed', last_error: msg });
    await audit(null, user, 'buffer_draft_failed', entry.id, { message: msg });
    return { destination: 'linkedin', status: 'failed', error: msg, publication_id: pub.id };
  }
}

// Publishes an approved entry to its chosen destinations. LinkedIn only ever gets a DRAFT in Buffer.
async function publishEntry(user, id) {
  const entry = await getSnapshotRow(id);
  if (!['approved', 'failed'].includes(entry.status) || !entry.approved_snapshot) {
    throw new HttpError(409, 'bad_transition', 'Only approved entries can be published.');
  }
  const dests = entry.approved_snapshot.destinations || {};
  const results = [];
  if (dests.website) results.push(await publishWebsite(user, entry));
  if (dests.linkedin) results.push(await publishLinkedIn(user, entry));
  const allOk = results.length > 0 && results.every((r) => r.status === 'verified');
  const to = allOk ? 'published' : 'failed';
  await tx(async (client) => {
    const fresh = await E.getEntry(id, client);
    if (fresh.version !== entry.version) return; // edited meanwhile: leave it as the edit left it
    if (fresh.status !== to) await E.setStatus(client, user, fresh, to, allOk ? 'entry_published' : 'entry_publish_failed', { results: results.map((r) => ({ d: r.destination, s: r.status })) });
  });
  return { status: to, results, entry: await E.getEntry(id) };
}

async function unpublish(user, id) {
  return tx(async (client) => {
    const entry = await E.getEntry(id, client);
    await client.query('update entries set live_snapshot = null, live_at = null where id = $1', [id]);
    if (entry.status === 'published') await E.setStatus(client, user, entry, 'approved', 'entry_unpublished', {});
    else await audit(client, user, 'entry_unpublished', id, { status: entry.status });
    return E.getEntry(id, client);
  });
}

async function listPublications(entryId) {
  return (await query('select id, destination, channel_id, status, buffer_post_id, attempts, last_error, verified_at, updated_at from publications where entry_id = $1 order by created_at desc', [entryId])).rows;
}

// For an "uncertain" LinkedIn publication a person checks Buffer, then either links the draft they found or allows a retry.
// For a failed read-back (wrong draft in Buffer) they can discard the link after deleting that draft in Buffer.
async function resolveUncertain(user, publicationId, input) {
  const { rows } = await query('select * from publications where id = $1', [publicationId]);
  const pub = rows[0];
  if (!pub) throw new HttpError(404, 'not_found', 'Publication not found.');
  if (input.action === 'discard') {
    if (!['failed', 'saved'].includes(pub.status) || !pub.buffer_post_id) throw new HttpError(409, 'bad_transition', 'There is no saved draft to discard.');
    await setPub(pub.id, { status: 'failed', buffer_post_id: null, last_error: 'The earlier Buffer draft was discarded by ' + user.email + '. A new draft will be created.' });
    await audit(null, user, 'buffer_draft_discarded', pub.entry_id, { publication_id: pub.id, buffer_post_id: pub.buffer_post_id });
    return { status: 'failed' };
  }
  if (pub.status !== 'uncertain') throw new HttpError(409, 'bad_transition', 'That publication is not waiting for a decision.');
  if (input.action === 'retry') {
    await setPub(pub.id, { status: 'failed', last_error: 'Confirmed by ' + user.email + ' that no draft exists. Safe to create again.' });
    await audit(null, user, 'buffer_uncertain_retry_allowed', pub.entry_id, { publication_id: pub.id });
    return { status: 'failed' };
  }
  if (input.action === 'link') {
    const id = String(input.buffer_post_id || '').trim();
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new HttpError(422, 'validation', 'Enter the Buffer post id (24 characters).');
    await setPub(pub.id, { status: 'saved', buffer_post_id: id, last_error: null });
    await audit(null, user, 'buffer_uncertain_linked', pub.entry_id, { publication_id: pub.id, buffer_post_id: id });
    return { status: 'saved' };
  }
  throw new HttpError(422, 'validation', 'Choose retry, link or discard.');
}

module.exports = { publishEntry, unpublish, listPublications, resolveUncertain, publishLinkedIn };
