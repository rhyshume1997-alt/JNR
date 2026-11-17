# Production readiness: status of open items

Updated with the launch-readiness commit. Items marked FIXED have regression tests in `test/launch-readiness.test.js` (and the browser tests).
The runbook for production setup, backups, rollback and smoke tests is `docs/PRODUCTION-RUNBOOK.md`.

## Fixed in the launch-readiness commit

1. **Stale public pages after unpublish: FIXED.** `/our-work`, case pages, `/api/feed` and `/sitemap-work.xml` are sent with `Cache-Control: no-store`
   (previously a 60 second edge cache plus up to 10 minutes of stale serving). "Take off the website" takes effect on the next request.
   A short cache can come back later together with an explicit purge on unpublish; each page view now reads the database, which is fine for the first launch.
2. **Independent approval: FIXED.** The author and the person who made the latest content change (wording, caption, destinations, photos added, removed,
   re-ordered or re-described) cannot approve. Ticking a photo as checked or editing private notes is review work and does not count. An **admin may override**; that
   approval is recorded in the audit history as `independent_approval_overridden`. With one editor and one admin, the admin approves what the editor changed.
3. **Remove a photo versus publish race: FIXED.** Publishing only goes ahead if the entry is still the approved version, and records itself (the live copy, or
   the pending Buffer draft) in the same step that checks it; a photo removal changes the version before it decides whether its public copies are still used. Either
   the publication is refused (409, "changed while it was being published") or the removal keeps the copies. A retry of an earlier failed Buffer attempt counts as in use from the moment it starts.
4. **"Still live on website" indicator: FIXED.** A published entry that went back to draft shows a notice and a "Still live on website" badge in the dashboard and list.
   Taking an entry off the website stays admin-only for the first release.
5. **LinkedIn switch (added for the website-only launch).** `LINKEDIN_ENABLED=false`, or no Buffer token, turns LinkedIn off: the tick box is replaced by a message,
   the server refuses to save the setting, and publishing never contacts Buffer.

## Deferred by decision (manual review during a limited launch; documented limitations)

- **Drawing-reference warning** is too eager: it accepts any word after "drawing" ("checked against the drawing before it left" is flagged). It is only a warning
  that the editor ticks. Fix later by requiring a digit in the reference.
- **Ambiguous purchase order formats are not detected:** `PO ABC` (no digit), `POAB1234` (no separator), and `P0` typed with a zero. The editor reading the text at
  approval is the safeguard. Production option: flag ambiguous formats for human review rather than widen the pattern (which would block ordinary words).
- **LinkedIn tick needs a Save first:** the destination only takes effect once saved. It fails safe (nothing is sent) and the confirmation says "LinkedIn: not selected".
- **Version-conflict message** ("Someone else changed this entry") after ticking a photo and pressing Save in one go.

## Must be resolved before the JNR company LinkedIn integration is enabled

**Public copies kept for Buffer drafts.** When a photo is removed from an entry that has a Buffer draft, its public copies are kept, because the draft points at them. They are
recorded (`public_copies_retained`) and released by `npm run cleanup:orphans` only when nothing uses them; an entry with a Buffer draft keeps all of them indefinitely. Decide
before enabling LinkedIn: (a) an admin "close publication" action that releases them once the draft has been published or deleted in Buffer, (b) automatic release after a
fixed number of days, or (c) accept the small storage cost. Recommendation: (a) with (b) as a backstop. Not needed for a website-only launch.
