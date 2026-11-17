# Production readiness: open items that need an explicit decision

These do not block the staging retest. Each needs a decision before anything is merged or deployed to production.

## 1. Removing a photo while the entry is being published (race)

`deleteImage` decides whether a photo's public copies are still in use (live website snapshot, Buffer draft) and then deletes the
private original and, if unused, the public copies. `publishEntry` reads the approved snapshot and writes the live snapshot / creates
the Buffer draft in separate steps and does not hold a lock across them. If someone removes a photo in the instant between those
steps, a published page or a new Buffer draft can briefly point at a public copy that has just been deleted (a broken image until the
entry is re-approved and re-published). Narrow window; no private data is exposed. The entry itself is returned to draft by the
removal, so the office sees it. Options before production: (a) hold the entry row lock across the whole publish and across
`deleteImage` (a small change in `api/_lib/publish.js`), (b) refuse photo removal while a publish for the entry is in progress, or
(c) accept and document. Recommendation: (a).

## 2. Public copies kept because of a Buffer draft

When a photo is removed from an entry that has a LinkedIn publication (a Buffer draft that was saved, verified, uncertain or pending),
its public copies are **kept**, because the draft in Buffer points at those public addresses and deleting them would break the draft.
They are recorded in the audit history (`public_copies_retained`). Today `npm run cleanup:orphans` releases such copies only when the
entry has no Buffer publication left in use; an entry with a Buffer draft keeps all of them indefinitely. This is a small, permanent
storage cost on a public bucket, nothing private. How it will be released: once the Buffer draft has been published or deleted by a
person in Buffer, an administrator marks the publication as closed (a small admin action that does not exist yet), after which
`cleanup:orphans` removes the retained copies. Decide before production: (a) build that "close publication" action, (b) release
copies automatically after a fixed number of days, or (c) accept the cost. Recommendation: (a) with (b) as a backstop.

## 3. Other items already listed elsewhere

- `docs/SECURITY-REVIEW.md` "Still open": two-factor sign-in, password reset email, `connect-src` tied to R2.
- Production media hosting and permanent media URLs (r2.dev is development only), production database and storage, backups and
  restore, JNR company LinkedIn connection, regression tests of the existing site, rollback: see the production readiness report.
