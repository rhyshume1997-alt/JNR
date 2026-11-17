'use strict';

const crypto = require('node:crypto');
const { query, tx } = require('./db');
const { audit } = require('./auth');
const { HttpError } = require('./http');
const M = require('./model');
const { scanPublicText } = require('./confidential');
const { storage } = require('./s3');
const images = require('./images');
const { getConfig } = require('./config');

const ENTRY_COLS = 'id, kind, status, title, summary, material, process, stage, body, is_case_study, event_date, job_ref, customer_name, customer_notes, internal_notes, rough_notes, customer_public_ok, customer_public_label, destinations, caption, caption_source, slug, version, created_by, created_at, updated_at, submitted_at, reviewed_by, reviewed_at, review_note, approved_at, live_at, (live_snapshot is not null) as is_live';

const HAS_APPROVED_COPY = ['approved', 'published', 'failed'];

function isoDate(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : d; }
function shape(row) { if (row) row.event_date = isoDate(row.event_date); return row; }

async function getEntry(id, client) {
  const q = client ? client.query.bind(client) : query;
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new HttpError(404, 'not_found', 'Entry not found.');
  const { rows } = await q('select ' + ENTRY_COLS + ' from entries where id = $1' + (client ? ' for update' : ''), [id]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Entry not found.');
  return shape(rows[0]);
}

function assertCanSee(user, entry) {
  if (M.hasRole(user, 'editor')) return;
  if (entry.created_by !== user.id) throw new HttpError(404, 'not_found', 'Entry not found.');
}

// Workshop users only see and edit their own entries, and only before approval.
function assertCanEditContent(user, entry) {
  assertCanSee(user, entry);
  if (!M.hasRole(user, 'editor') && !['draft', 'rejected'].includes(entry.status)) {
    throw new HttpError(403, 'forbidden', 'This entry is with the office now. Ask an editor to change it.');
  }
}

// Strip private fields for roles that should not see them.
function viewFor(user, entry) {
  const e = Object.assign({}, entry);
  if (!M.hasRole(user, 'editor')) { delete e.internal_notes; }
  return e;
}

async function listEntries(user, opts) {
  const where = [];
  const params = [];
  if (!M.hasRole(user, 'editor')) { params.push(user.id); where.push('created_by = $' + params.length); }
  if (opts.status && M.STATUSES.includes(opts.status)) { params.push(opts.status); where.push('status = $' + params.length); }
  if (opts.q) { params.push('%' + String(opts.q).replace(/[%_\\]/g, '\\$&') + '%'); where.push('(title ilike $' + params.length + ' or summary ilike $' + params.length + ')'); }
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const { rows } = await query(
    'select ' + ENTRY_COLS + ', (select count(*) from entry_images i where i.entry_id = entries.id and i.state = \'ready\')::int as image_count' +
    ' from entries' + (where.length ? ' where ' + where.join(' and ') : '') + ' order by updated_at desc limit ' + limit + ' offset ' + offset, params);
  return rows.map(shape).map((r) => viewFor(user, r));
}

async function statusCounts(user) {
  const own = M.hasRole(user, 'editor') ? '' : ' where created_by = $1';
  const { rows } = await query('select status, count(*)::int as n from entries' + own + ' group by status', own ? [user.id] : []);
  const out = {}; M.STATUSES.forEach((s) => { out[s] = 0; }); rows.forEach((r) => { out[r.status] = r.n; });
  return out;
}

// readyOnly: leave out uploads that have not finished (they are not photos yet, and a failed one must never show up or block anything).
async function getImages(entryId, client, opts) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    'select id, entry_id, position, state, original_name, content_type, bytes, width, height, alt_text, cleared_for_public, (public_key is not null) as has_public from entry_images where entry_id = $1' + (opts && opts.readyOnly ? " and state = 'ready'" : '') + ' order by position, created_at', [entryId]);
  return rows;
}

// An upload link lasts presignSeconds. A row still "awaiting" after that can never complete: it is an abandoned upload (the phone lost
// signal, the tab closed). The row is claimed and removed, then its stored object; if the object cannot be removed that is recorded
// in the audit history (storage_delete_failed) so cleanup:orphans can retry it, which is how abandoned objects stay findable.
async function purgeAbandonedUploads(entryId) {
  const grace = Number(getConfig().upload.presignSeconds) + 60;
  const stale = await query("select id from entry_images where entry_id = $1 and state = 'awaiting_upload' and created_at < now() - ($2 || ' seconds')::interval", [entryId, String(grace)]);
  let purged = 0;
  for (const r of stale.rows) {
    // Claim the row first. If a slow upload finished in the meantime the row is no longer "awaiting", nothing is returned, and its
    // object is left alone.
    const claimed = await query("delete from entry_images where id = $1 and state = 'awaiting_upload' returning original_key", [r.id]);
    if (!claimed.rows[0]) continue;
    purged++;
    try { await storage.del('privateBucket', claimed.rows[0].original_key); } catch (e) {
      console.error('Could not delete abandoned upload', claimed.rows[0].original_key, e.message);
      await audit(null, { email: 'system' }, 'storage_delete_failed', entryId, { keys: ['private:' + claimed.rows[0].original_key] });
    }
  }
  return purged;
}

async function createEntry(user, input, idemKey) {
  const fields = M.validateEntryFields(Object.assign({ destinations: { website: true, linkedin: false } }, input));
  if (fields.destinations && fields.destinations.linkedin === true && !getConfig().buffer.enabled) throw new HttpError(422, 'linkedin_disabled', 'LinkedIn drafts are switched off on this site.');
  if (!M.hasRole(user, 'admin')) { delete fields.customer_public_ok; delete fields.customer_public_label; }
  const key = idemKey ? String(idemKey).slice(0, 100) : null;
  return tx(async (client) => {
    if (key) {
      const prior = await client.query('select entry_id from idempotency_keys where key = $1 and user_id = $2', [key, user.id]);
      if (prior.rows[0] && prior.rows[0].entry_id) return { entry: await getEntry(prior.rows[0].entry_id, client), replayed: true };
      const taken = await client.query('select 1 from idempotency_keys where key = $1', [key]);
      if (taken.rows[0]) throw new HttpError(409, 'idempotency_conflict', 'That request key was already used.');
    }
    const cols = Object.keys(fields);
    const { rows } = await client.query(
      'insert into entries (' + cols.concat(['created_by']).join(', ') + ') values (' + cols.concat(['created_by']).map((_, i) => '$' + (i + 1)).join(', ') + ') returning id',
      cols.map((c) => (c === 'destinations' ? JSON.stringify(fields[c]) : fields[c])).concat([user.id]));
    const id = rows[0].id;
    if (key) await client.query('insert into idempotency_keys (key, user_id, entry_id) values ($1,$2,$3)', [key, user.id, id]);
    await audit(client, user, 'entry_created', id, { kind: fields.kind });
    return { entry: await getEntry(id, client), replayed: false };
  });
}

async function updateEntry(user, id, input) {
  return tx(async (client) => {
    const entry = await getEntry(id, client);
    assertCanEditContent(user, entry);
    const fields = M.validateEntryFields(input, { partial: true });
    if (!M.hasRole(user, 'admin')) { delete fields.customer_public_ok; delete fields.customer_public_label; }
    if (!M.hasRole(user, 'editor')) { delete fields.internal_notes; delete fields.destinations; }
    if (fields.destinations && fields.destinations.linkedin === true && entry.destinations.linkedin !== true && !getConfig().buffer.enabled) {
      throw new HttpError(422, 'linkedin_disabled', 'LinkedIn drafts are switched off on this site.');
    }
    if (input.version !== undefined && Number(input.version) !== entry.version) {
      throw new HttpError(409, 'conflict', 'Someone else changed this entry. Reload to see their changes.');
    }
    const changed = Object.keys(fields).filter((k) => JSON.stringify(fields[k]) !== JSON.stringify(entry[k]) && !(fields[k] == null && entry[k] == null));
    if (!changed.length) return { entry, changed: [] };
    if (fields.caption !== undefined && changed.includes('caption')) fields.caption_source = fields.caption ? 'manual' : 'none';
    const contentChanged = changed.some((k) => M.CONTENT_FIELDS.includes(k));
    // Only entries that already have an approved copy go back to draft. A reviewer fixing a typo while an entry is
    // waiting for approval does not bounce it: the approved copy is only taken at the moment of approval.
    const resets = contentChanged && HAS_APPROVED_COPY.includes(entry.status);
    const sets = Object.keys(fields).concat(resets ? ['status'] : []);
    const vals = Object.keys(fields).map((k) => (k === 'destinations' ? JSON.stringify(fields[k]) : fields[k]));
    if (resets) vals.push('draft');
    const setSql = sets.map((c, i) => c + ' = $' + (i + 2)).join(', ');
    await client.query('update entries set ' + setSql + ', version = version + 1, updated_at = now()' +
      (resets ? ', approved_snapshot = null, approved_at = null' : '') + ' where id = $1', [id].concat(vals));
    const detail = { fields: changed, values: {} };
    changed.forEach((k) => { if (!M.PRIVATE_FIELDS.includes(k) && k !== 'caption' && k !== 'body') detail.values[k] = fields[k]; });
    if (resets) detail.status_reset = { from: entry.status, to: 'draft' };
    await audit(client, user, 'entry_updated', id, detail);
    return { entry: await getEntry(id, client), changed };
  });
}

async function setStatus(client, user, entry, to, action, detail, extraSets, extraVals) {
  if (!M.canTransition(entry.status, to)) throw new HttpError(409, 'bad_transition', 'An entry that is ' + entry.status.replace('_', ' ') + ' cannot move to ' + to.replace('_', ' ') + '.');
  const sets = ['status = $2', 'updated_at = now()'].concat(extraSets || []);
  await client.query('update entries set ' + sets.join(', ') + ' where id = $1', [entry.id, to].concat(extraVals || []));
  await audit(client, user, action, entry.id, Object.assign({ from: entry.status, to }, detail || {}));
}

async function submitEntry(user, id) {
  assertCanEditContent(user, await getEntry(id));
  await purgeAbandonedUploads(id);
  return tx(async (client) => {
    const entry = await getEntry(id, client);
    assertCanEditContent(user, entry);
    const imgs = await getImages(id, client);
    if (imgs.some((i) => i.state !== 'ready')) throw new HttpError(409, 'uploads_incomplete', 'Some photos have not finished uploading.');
    M.validateEntryFields(entry);
    await setStatus(client, user, entry, 'pending_approval', 'entry_submitted', {}, ['submitted_at = now()', 'review_note = null']);
    return getEntry(id, client);
  });
}

// What approval checks. Used to preview too, so the approver sees the same findings the approve action will use.
async function reviewChecks(entry, imgs) {
  const scan = scanPublicText(entry);
  const problems = [];
  const included = imgs.filter((i) => i.state === 'ready' && i.cleared_for_public);
  if (!entry.destinations.website && !entry.destinations.linkedin) problems.push({ code: 'no_destination', message: 'Choose at least one destination.' });
  if (entry.destinations.linkedin && !entry.caption) problems.push({ code: 'no_caption', message: 'Add or generate a LinkedIn caption.' });
  imgs.filter((i) => i.state === 'ready' && !i.cleared_for_public).forEach((i) => {
    problems.push({ code: 'image_not_cleared', imageId: i.id, message: 'Photo ' + (i.position + 1) + ' has not been checked. Tick "No drawings or customer details" or remove it.', soft: true });
  });
  return { blocking: scan.blocking.concat(problems.filter((p) => !p.soft && p.code !== 'image_not_cleared')), warnings: scan.warnings, uncleared: problems.filter((p) => p.code === 'image_not_cleared'), includedImages: included };
}

async function previewApproval(user, id) {
  const entry = await getEntry(id);
  assertCanSee(user, entry);
  const imgs = await getImages(id);
  const r = await reviewChecks(entry, imgs);
  return { blocking: r.blocking, warnings: r.warnings, uncleared_images: r.uncleared.map((u) => u.imageId), will_publish_images: r.includedImages.length };
}

function snapshotOf(entry, publicImages) {
  return {
    version: entry.version, kind: entry.kind, title: entry.title, summary: entry.summary, body: entry.body,
    is_case_study: entry.is_case_study, material: entry.material, process: entry.process, stage: entry.stage,
    event_date: entry.event_date, customer: entry.customer_public_ok ? (entry.customer_public_label || null) : null,
    images: publicImages, caption: entry.caption, destinations: entry.destinations, slug: entry.slug,
  };
}

// Who made the most recent change to what the entry says or shows: public wording, caption, destinations, photos added, removed,
// re-ordered or re-described. A reviewer ticking a photo as "checked", or editing private notes, is review work, not a content change.
// Null if nobody has changed it since it was created.
async function lastContentEditor(entryId) {
  const { rows } = await query("select actor_id, action, detail from audit_log where entry_id = $1 and action in ('entry_updated','image_added','image_removed','images_reordered','image_updated') order by id desc", [entryId]);
  for (const r of rows) {
    const fields = (r.detail && r.detail.fields) || [];
    if (r.action === 'entry_updated' && !fields.some((f) => M.CONTENT_FIELDS.includes(f))) continue;
    // Re-describing a photo, or taking it out of the public set (un-ticking), changes what is published; ticking it in is review work.
    if (r.action === 'image_updated' && !(fields.includes('alt_text') || (fields.includes('cleared_for_public') && r.detail.cleared_for_public === false))) continue;
    return r.actor_id;
  }
  return null;
}

async function approveEntry(user, id, input) {
  const acknowledged = new Set((input && input.acknowledge) || []);
  // Pass 1: read and check, then do the slow image work outside the transaction.
  const entry = await getEntry(id);
  if (entry.status !== 'pending_approval') throw new HttpError(409, 'bad_transition', 'Only entries waiting for approval can be approved.');
  // Independent approval: the person who wrote the entry, and the person who made the latest change to it, cannot approve it.
  // An admin may (the documented override); that is recorded in the audit history.
  const lastEditor = await lastContentEditor(id);
  const notIndependent = entry.created_by === user.id || lastEditor === user.id;
  if (notIndependent && !M.hasRole(user, 'admin')) {
    throw new HttpError(403, 'forbidden', entry.created_by === user.id ? 'Someone else needs to approve your own entry.' : 'Someone else needs to approve this: you made the latest change to it.');
  }
  const imgs = await getImages(id);
  const r = await reviewChecks(entry, imgs);
  if (r.blocking.length) throw new HttpError(422, 'blocked', 'This entry cannot be approved yet.', { blocking: r.blocking });
  const unacked = r.warnings.filter((w) => !acknowledged.has(w.code + ':' + w.field));
  if (unacked.length) throw new HttpError(422, 'needs_acknowledgement', 'Confirm the warnings before approving.', { warnings: unacked });
  if (r.uncleared.length && !(input && input.excludeUncleared === true)) {
    throw new HttpError(422, 'images_not_cleared', 'Some photos are not marked as checked. Check them, or approve without them.', { images: r.uncleared.map((u) => u.imageId) });
  }

  const publicImages = [];
  const keysToSet = [];
  for (const img of r.includedImages) {
    const { rows } = await query('select original_key, sha256 from entry_images where id = $1', [img.id]);
    const original = await storage.get('privateBucket', rows[0].original_key, getConfig().upload.maxBytes);
    if (!original) throw new HttpError(502, 'storage_missing', 'A photo is missing from storage. Re-upload it.');
    const copies = await images.makePublicCopies(original);
    const tag = rows[0].sha256.slice(0, 10);
    const largeKey = 'public/' + id + '/' + img.id + '-' + tag + '-1600.jpg';
    const thumbKey = 'public/' + id + '/' + img.id + '-' + tag + '-640.jpg';
    await storage.put('publicBucket', largeKey, copies.large.buffer, 'image/jpeg', 'public, max-age=31536000, immutable');
    await storage.put('publicBucket', thumbKey, copies.thumb.buffer, 'image/jpeg', 'public, max-age=31536000, immutable');
    keysToSet.push({ id: img.id, largeKey, thumbKey });
    publicImages.push({ id: img.id, url: storage.publicUrl(largeKey), thumb_url: storage.publicUrl(thumbKey), width: copies.large.width, height: copies.large.height, thumb_width: copies.thumb.width, thumb_height: copies.thumb.height, alt: img.alt_text || entry.title });
  }

  return tx(async (client) => {
    const fresh = await getEntry(id, client);
    if (fresh.version !== entry.version || fresh.status !== 'pending_approval') throw new HttpError(409, 'conflict', 'The entry changed while it was being approved. Review it again.');
    for (const k of keysToSet) await client.query('update entry_images set public_key = $2, public_thumb_key = $3 where id = $1', [k.id, k.largeKey, k.thumbKey]);
    let slug = fresh.slug;
    if (!slug) slug = M.slugify(fresh.title) + '-' + crypto.randomBytes(2).toString('hex');
    fresh.slug = slug;
    const snap = snapshotOf(fresh, publicImages);
    await setStatus(client, user, fresh, 'approved', 'entry_approved',
      { warnings_acknowledged: Array.from(acknowledged), images_published: publicImages.length, images_excluded: r.uncleared.length, independent_approval_overridden: notIndependent || undefined },
      ['reviewed_by = $3', 'reviewed_at = now()', 'approved_at = now()', 'approved_snapshot = $4', 'slug = $5', 'review_note = null'],
      [user.id, JSON.stringify(snap), slug]);
    return getEntry(id, client);
  });
}

async function rejectEntry(user, id, note) {
  const n = M.clean(note);
  if (n.length < 3) throw new HttpError(422, 'validation', 'Say what needs changing.', { errors: { note: 'Say what needs changing.' } });
  return tx(async (client) => {
    const entry = await getEntry(id, client);
    await setStatus(client, user, entry, 'rejected', 'entry_rejected', { note: n }, ['reviewed_by = $3', 'reviewed_at = now()', 'review_note = $4'], [user.id, n]);
    return getEntry(id, client);
  });
}

async function setImageOrder(user, entryId, order) {
  if (!Array.isArray(order)) throw new HttpError(422, 'validation', 'Send the photo order as a list.');
  return tx(async (client) => {
    const entry = await getEntry(entryId, client);
    assertCanEditContent(user, entry);
    const imgs = await getImages(entryId, client, { readyOnly: true });
    const ids = imgs.map((i) => i.id).sort();
    if (JSON.stringify(order.slice().sort()) !== JSON.stringify(ids)) throw new HttpError(422, 'validation', 'The order must list every photo exactly once.');
    for (let i = 0; i < order.length; i++) await client.query('update entry_images set position = $2 where id = $1', [order[i], i]);
    await touchContent(client, user, entry, 'images_reordered', {});
    return getImages(entryId, client, { readyOnly: true });
  });
}

// Image changes are content changes: an approved entry goes back to draft so the approved copy can't drift.
async function touchContent(client, user, entry, action, detail) {
  const reset = HAS_APPROVED_COPY.includes(entry.status);
  await client.query('update entries set version = version + 1, updated_at = now()' + (reset ? ", status = 'draft', approved_snapshot = null, approved_at = null" : '') + ' where id = $1', [entry.id]);
  await audit(client, user, action, entry.id, Object.assign({}, detail, reset ? { status_reset: { from: entry.status, to: 'draft' } } : {}));
}

async function updateImage(user, imageId, input) {
  return tx(async (client) => {
    const { rows } = await client.query('select entry_id, alt_text, cleared_for_public from entry_images where id = $1', [imageId]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Photo not found.');
    const entry = await getEntry(rows[0].entry_id, client);
    assertCanEditContent(user, entry);
    const sets = []; const vals = [imageId]; const changed = [];
    if (input.alt_text !== undefined) {
      const a = M.clean(input.alt_text);
      if (a.length > 300) throw new HttpError(422, 'validation', 'Description is too long.');
      if (a !== rows[0].alt_text) { vals.push(a); sets.push('alt_text = $' + vals.length); changed.push('alt_text'); }
    }
    if (input.cleared_for_public !== undefined && (input.cleared_for_public === true) !== rows[0].cleared_for_public) {
      vals.push(input.cleared_for_public === true); sets.push('cleared_for_public = $' + vals.length); changed.push('cleared_for_public');
    }
    // Only what really changed is saved and recorded (the dashboard sends both fields each time).
    if (!sets.length) return (await getImages(entry.id, client)).find((i) => i.id === imageId);
    await client.query('update entry_images set ' + sets.join(', ') + ' where id = $1', vals);
    await touchContent(client, user, entry, 'image_updated', { image_id: imageId, fields: changed, cleared_for_public: changed.includes('cleared_for_public') ? input.cleared_for_public === true : undefined });
    return (await getImages(entry.id, client)).find((i) => i.id === imageId);
  });
}

// Is a stored public copy still used by something outside this draft? The live website reads live_snapshot, and a Buffer draft
// (anything not a plain failure) was built from the same public addresses. Nothing here is "approved but not yet public": an
// approval snapshot is discarded by the very edit that removes the photo.
async function publicCopiesInUse(entryId, imageId) {
  const { rows } = await query('select live_snapshot from entries where id = $1', [entryId]);
  const live = rows[0] && rows[0].live_snapshot;
  if (live && Array.isArray(live.images) && live.images.some((i) => i.id === imageId)) return true;
  const pubs = await query("select 1 from publications where entry_id = $1 and destination = 'linkedin' and (buffer_post_id is not null or status in ('pending','sending','saved','verified','uncertain') or updated_at > now() - interval '10 minutes') limit 1", [entryId]);
  return pubs.rows.length > 0;
}

async function deleteImage(user, imageId) {
  const { rows } = await query('select entry_id, state, original_key, public_key, public_thumb_key from entry_images where id = $1', [imageId]);
  const img = rows[0];
  if (!img) throw new HttpError(404, 'not_found', 'Photo not found.');
  await tx(async (client) => {
    const entry = await getEntry(img.entry_id, client);
    assertCanEditContent(user, entry);
    await client.query('delete from entry_images where id = $1', [imageId]);
    // An unfinished upload is not part of the entry yet: removing one changes nothing the office has seen.
    if (img.state !== 'ready') return;
    const remaining = await getImages(entry.id, client, { readyOnly: true });
    for (let i = 0; i < remaining.length; i++) await client.query('update entry_images set position = $2 where id = $1', [remaining[i].id, i]);
    await touchContent(client, user, entry, 'image_removed', { image_id: imageId });
  });
  // Storage. The private original always goes. Public copies go too unless the live site or a Buffer draft still uses them.
  const keys = [{ bucket: 'privateBucket', key: img.original_key }];
  const publicKeys = [img.public_key, img.public_thumb_key].filter(Boolean);
  if (img.state === 'ready' && publicKeys.length) {
    if (await publicCopiesInUse(img.entry_id, imageId)) {
      // Kept for now. Recorded so releasePublicCopies() can remove them once the live site and Buffer no longer use them.
      await audit(null, user, 'public_copies_retained', img.entry_id, { image_id: imageId, keys: publicKeys });
    } else publicKeys.forEach((k) => keys.push({ bucket: 'publicBucket', key: k }));
  }
  const left = [];
  for (const k of keys) {
    try { await storage.del(k.bucket, k.key); } catch (e) { console.error('Could not delete', k.key, e.message); left.push(k.bucket === 'privateBucket' ? 'private:' + k.key : 'public:' + k.key); }
  }
  // Recorded so nothing is forgotten: these objects have no database row any more.
  if (left.length) await audit(null, user, 'storage_delete_failed', img.entry_id, { keys: left });
}

// Removes public copies of photos that were taken off an entry while something still used them, once nothing does (the entry was
// re-published without the photo and no Buffer draft is attached). Returns how many objects it removed. Safe to run repeatedly.
async function releasePublicCopies() {
  const { rows } = await query("select a.id, a.entry_id, a.detail from audit_log a where a.action = 'public_copies_retained' and not exists (select 1 from audit_log r where r.action = 'public_copies_released' and r.detail->>'image_id' = a.detail->>'image_id') order by a.id");
  let removed = 0;
  for (const r of rows) {
    const imageId = r.detail && r.detail.image_id;
    const exists = (await query('select 1 from entries where id = $1', [r.entry_id])).rows.length > 0;
    if (exists && await publicCopiesInUse(r.entry_id, imageId)) continue;
    let ok = true;
    for (const k of (r.detail && r.detail.keys) || []) {
      try { await storage.del('publicBucket', k); removed++; } catch (e) { ok = false; console.error('Could not delete', k, e.message); }
    }
    if (ok) await audit(null, { email: 'system' }, 'public_copies_released', exists ? r.entry_id : null, { image_id: imageId });
  }
  return removed;
}

async function presignImage(user, entryId, file) {
  const cfg = getConfig().upload;
  const entry = await getEntry(entryId);
  assertCanEditContent(user, entry);
  const type = String(file.type || '');
  if (!images.ALLOWED_TYPES.includes(type)) throw new HttpError(422, 'not_a_photo', 'Only JPEG, PNG or WebP photographs are accepted. Drawings and CAD files are not allowed here.');
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(422, 'validation', 'File size missing.');
  if (size > cfg.maxBytes) throw new HttpError(422, 'too_large', 'That photo is over ' + Math.round(cfg.maxBytes / 1048576) + 'MB.');
  const name = M.clean(file.name).slice(0, 120);
  await purgeAbandonedUploads(entryId);
  // A retry of the same file reuses its unfinished upload instead of adding another row.
  const again = await query("select id, original_key from entry_images where entry_id = $1 and state = 'awaiting_upload' and original_name = $2 and bytes = $3 and content_type = $4 order by created_at desc limit 1", [entryId, name, size, type]);
  if (again.rows[0]) {
    await query('update entry_images set created_at = now() where id = $1', [again.rows[0].id]);
    return { image_id: again.rows[0].id, upload: storage.presignUpload(again.rows[0].original_key, type, size) };
  }
  // Only finished photos count toward the limit; unfinished uploads have their own, separate bound.
  const { rows: cnt } = await query("select count(*) filter (where state = 'ready')::int as ready, count(*) filter (where state = 'awaiting_upload')::int as pending, coalesce(max(position), -1)::int as top from entry_images where entry_id = $1", [entryId]);
  if (cnt[0].ready >= cfg.maxPerEntry) throw new HttpError(422, 'too_many', 'No more than ' + cfg.maxPerEntry + ' photos per entry.');
  if (cnt[0].pending >= cfg.maxPerEntry) throw new HttpError(429, 'too_many_pending', 'Too many uploads are still unfinished. Wait a few minutes, or remove them, then try again.');
  const imageId = crypto.randomUUID();
  const key = 'originals/' + entryId + '/' + imageId;
  await query('insert into entry_images (id, entry_id, position, original_key, original_name, content_type, bytes) values ($1,$2,$3,$4,$5,$6,$7)', [imageId, entryId, cnt[0].top + 1, key, name, type, size]);
  return { image_id: imageId, upload: storage.presignUpload(key, type, size) };
}

async function finalizeImage(user, imageId) {
  const { rows } = await query('select * from entry_images where id = $1', [imageId]);
  const img = rows[0];
  if (!img) throw new HttpError(404, 'not_found', 'Photo not found.');
  const entry = await getEntry(img.entry_id);
  assertCanEditContent(user, entry);
  if (img.state === 'ready') return (await getImages(img.entry_id)).find((i) => i.id === imageId);
  const cfg = getConfig().upload;
  // Refusing an upload removes it, but only while it is still unfinished: a photo another request has just completed is never touched.
  const reject = async (err) => {
    const gone = await query("delete from entry_images where id = $1 and state = 'awaiting_upload' returning id", [imageId]);
    if (gone.rows[0]) {
      try { await storage.del('privateBucket', img.original_key); } catch (_) { /* ignore */ }
      await audit(null, user, 'upload_rejected', img.entry_id, { code: err.code, name: img.original_name });
    }
    throw err;
  };
  const head = await storage.head('privateBucket', img.original_key);
  if (!head) throw new HttpError(409, 'upload_missing', 'The upload did not arrive. Try that photo again.');
  if (head.bytes > cfg.maxBytes) return reject(new HttpError(422, 'too_large', 'That photo is too large.'));
  const buf = await storage.get('privateBucket', img.original_key, cfg.maxBytes);
  let info;
  try { info = await images.inspectOriginal(buf, img.content_type); } catch (e) { return reject(e instanceof images.ImageError ? new HttpError(422, e.code, e.message) : e); }
  try {
    await tx(async (client) => {
      // The limit is enforced here, on finished photos, with the entry locked, so parallel uploads cannot slip past it together.
      await client.query('select 1 from entries where id = $1 for update', [img.entry_id]);
      const cur = await client.query('select state from entry_images where id = $1 for update', [imageId]);
      if (!cur.rows[0]) throw new HttpError(409, 'upload_missing', 'The upload did not arrive. Try that photo again.');   // cleared while it was being checked
      if (cur.rows[0].state === 'ready') return;                                                                           // another request already finished it
      const done = await client.query("select count(*)::int as n from entry_images where entry_id = $1 and state = 'ready' and id <> $2", [img.entry_id, imageId]);
      if (done.rows[0].n >= cfg.maxPerEntry) throw new HttpError(422, 'too_many', 'No more than ' + cfg.maxPerEntry + ' photos per entry.');
      await client.query('update entry_images set state = \'ready\', bytes = $2, sha256 = $3, width = $4, height = $5, content_type = $6 where id = $1 and state = \'awaiting_upload\'',
        [imageId, buf.length, info.sha256, info.width, info.height, info.contentType]);
      await touchContent(client, user, await getEntry(img.entry_id, client), 'image_added', { image_id: imageId, bytes: buf.length });
    });
  } catch (e) {
    if (e.code === '23505') return reject(new HttpError(409, 'duplicate', 'That photo is already on this entry.'));
    if (e instanceof HttpError && e.code === 'too_many') return reject(e);
    throw e;
  }
  return (await getImages(img.entry_id)).find((i) => i.id === imageId);
}

async function previewImage(user, imageId) {
  const { rows } = await query('select entry_id, original_key from entry_images where id = $1 and state = \'ready\'', [imageId]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Photo not found.');
  assertCanSee(user, await getEntry(rows[0].entry_id));
  const buf = await storage.get('privateBucket', rows[0].original_key, getConfig().upload.maxBytes);
  if (!buf) throw new HttpError(404, 'not_found', 'Photo not found.');
  return images.makePreview(buf);
}

async function entryAudit(user, entryId, limit) {
  const entry = await getEntry(entryId);
  assertCanSee(user, entry);
  const { rows } = await query('select at, actor_email, action, detail from audit_log where entry_id = $1 order by at desc, id desc limit $2', [entryId, Math.min(Number(limit) || 100, 200)]);
  return rows;
}

module.exports = {
  getEntry, listEntries, statusCounts, getImages, createEntry, updateEntry, submitEntry, previewApproval, approveEntry, rejectEntry,
  setImageOrder, updateImage, deleteImage, purgeAbandonedUploads, releasePublicCopies, presignImage, finalizeImage, previewImage, entryAudit, setStatus, snapshotOf, viewFor,
  assertCanSee, assertCanEditContent, ENTRY_COLS,
};
