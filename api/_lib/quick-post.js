'use strict';

// "Save as LinkedIn draft": the one-click path behind John's single page. It does NOT add any new approval logic: it runs the existing
// steps in order (save the caption, clear the photos John ticked, submit, approve, publish), so every existing check still applies:
// the confidentiality scan at approval, the audit history, the draft-only Buffer client with read-back, idempotent publishing.
// An admin approving his own work uses the override that is already built (recorded in the audit history). Anyone else still needs a second
// person (the independence rule), and the same errors come back so the page can say why.
//
// Buffer gets a DRAFT by default; John presses post in Buffer himself. Scheduling is opt-in, admin-only, needs the exact time confirmed
// a second time (confirm_schedule_at), must be in the future, and goes to Buffer only as a scheduled post (never "post now").

const { HttpError } = require('./http');
const { getConfig } = require('./config');
const M = require('./model');
const { query } = require('./db');

function firstChars(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '')).trim();
}

async function saveDraft(user, entryId, E, P, input) {
  const o = input || {};
  const caption = M.clean(o.caption);
  if (!caption) throw new HttpError(422, 'validation', 'Write or generate the post first.', { errors: { caption: 'Write or generate the post first.' } });
  if (caption.length > 3000) throw new HttpError(422, 'validation', 'The post is too long for LinkedIn (3000 characters at most).');
  const website = o.website === true;
  // Optional schedule: admin only, a real UTC time at least 5 minutes ahead, and the same time echoed back as the confirmation.
  let scheduleAt = null;
  if (o.schedule_at !== undefined && o.schedule_at !== null && o.schedule_at !== '') {
    if (user.role !== 'admin') throw new HttpError(403, 'admin_only', 'Only an admin can schedule a post.');
    const raw = String(o.schedule_at);
    const t = new Date(raw).getTime();
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(raw) || !Number.isFinite(t)) throw new HttpError(422, 'validation', 'That date and time was not understood.');
    if (t < Date.now() + 5 * 60 * 1000) throw new HttpError(422, 'validation', 'Pick a time at least 5 minutes from now.');
    if (t > Date.now() + 365 * 24 * 3600 * 1000) throw new HttpError(422, 'validation', 'Pick a time within the next year.');
    scheduleAt = new Date(t).toISOString();
    if (!o.confirm_schedule_at || new Date(String(o.confirm_schedule_at)).getTime() !== t) throw new HttpError(422, 'confirm_required', 'Confirm the date and time before this is scheduled.');
  }
  if (!getConfig().buffer.enabled) throw new HttpError(422, 'linkedin_disabled', 'Buffer is not connected on this site yet, so a LinkedIn draft cannot be saved.');

  let entry = await E.getEntry(entryId);
  E.assertCanSee(user, entry);
  if (scheduleAt) {
    // Checked before anything is changed. A changed post must not create a second scheduled post beside one already in Buffer.
    const prior = await query("select 1 from publications where entry_id = $1 and destination = 'linkedin' and buffer_post_id is not null limit 1", [entryId]);
    if (prior.rows[0]) throw new HttpError(409, 'already_in_buffer', 'This post is already in Buffer. Change or delete it in Buffer, or start a new post here.');
  }

  // 1. The photos John ticked as checked ("no drawings, screens or customer details"): the same per-photo flag as everywhere else.
  if (o.clear_photos === true) {
    for (const img of await E.getImages(entryId, null, { readyOnly: true })) {
      if (!img.cleared_for_public) await E.updateImage(user, img.id, { cleared_for_public: true });
    }
  }

  // 2. The post, and where it goes. LinkedIn is always a Buffer draft; the website is a separate, optional tick.
  const fields = { caption, destinations: { website, linkedin: true } };
  // Entries made on this page have no separate public description: the approved post text is what the website would show.
  if (o.use_caption_as_summary === true) fields.summary = firstChars(caption, 600) || entry.title;
  await E.updateEntry(user, entryId, fields);
  entry = await E.getEntry(entryId);

  // 3. Straight through: submit, approve (an admin approves his own work; recorded), publish.
  if (entry.status === 'published') {
    const pubs = await P.listPublications(entryId);
    return { status: 'published', already: true, results: [], publications: pubs, entry: E.viewFor(user, entry) };
  }
  if (['draft', 'rejected'].includes(entry.status)) { await E.submitEntry(user, entryId); entry = await E.getEntry(entryId); }
  if (entry.status === 'pending_approval') {
    await E.approveEntry(user, entryId, { acknowledge: Array.isArray(o.acknowledge) ? o.acknowledge.filter((x) => typeof x === 'string') : [] });
    entry = await E.getEntry(entryId);
  }
  const out = await P.publishEntry(user, entryId, scheduleAt ? { scheduleAt } : undefined);
  return { status: out.status, results: out.results, scheduled_for: scheduleAt || undefined, entry: E.viewFor(user, out.entry) };
}

module.exports = { saveDraft, firstChars };
