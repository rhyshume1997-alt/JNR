'use strict';

// "Save as LinkedIn draft": the one-click path behind John's single page. It does NOT add any new approval logic: it runs the existing
// steps in order (save the caption, clear the photos John ticked, submit, approve, publish), so every existing check still applies:
// the confidentiality scan at approval, the audit history, the draft-only Buffer client with read-back, idempotent publishing.
// An admin approving his own work uses the override that is already built (recorded in the audit history). Anyone else still needs a second
// person (the independence rule), and the same errors come back so the page can say why.
//
// Buffer only ever gets a DRAFT. Nothing is scheduled or published here, and John presses post in Buffer himself.

const { HttpError } = require('./http');
const { getConfig } = require('./config');
const M = require('./model');

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
  if (!getConfig().buffer.enabled) throw new HttpError(422, 'linkedin_disabled', 'Buffer is not connected on this site yet, so a LinkedIn draft cannot be saved.');

  let entry = await E.getEntry(entryId);
  E.assertCanSee(user, entry);

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
  const out = await P.publishEntry(user, entryId);
  return { status: out.status, results: out.results, entry: E.viewFor(user, out.entry) };
}

module.exports = { saveDraft, firstChars };
