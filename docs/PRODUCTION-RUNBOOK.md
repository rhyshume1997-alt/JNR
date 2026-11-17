# Production runbook (prepared, NOT applied)

Nothing in this document has been done. No production credential, database change or deployment has been made, and nothing may be
merged (`main` deploys to the live site) without Rhys's explicit approval.

**Recommended first launch: website only, LinkedIn switched off.** Staff post updates, the office approves, the website shows them.
LinkedIn drafts for the JNR company page are enabled later, separately, after the Buffer draft image retention decision (section 9).

## 1. Production configuration

Names, scope and which values are secret: `docs/vercel-production-env.example`. Everything is Production-only. Production has its own
Neon project, its own R2 buckets and its own access keys. LinkedIn is off with `LINKEDIN_ENABLED=false` (and with no Buffer token it
is off regardless). The code change that provides the switch is part of the readiness commit.

## 2. Isolated production database and storage

Verify each of these at setup time, with the person doing it ticking them off. Any "no" stops the launch.

| Check | How | Expect |
|---|---|---|
| Production database is a different Neon project from staging | Neon console: project names and the host part of `DATABASE_URL` | Different project and host |
| Staging scripts refuse production | `scripts/lib/guard.js` needs `DEPLOY_ENV=staging`, bucket names containing "staging", a staging channel | Refuses anything else (test: `test/staging-safety.test.js`) |
| Production buckets are not the staging buckets | Cloudflare R2 bucket names; `S3_BUCKET_*` in Vercel | `jnr-prod-private`, `jnr-prod-public`, never `jnr-staging-*` |
| Production R2 token is limited to the production buckets | Cloudflare token settings | Only those two buckets, Object Read & Write |
| The private bucket has no public access | R2: Public Development URL and custom domains on the private bucket | Both off |
| Staging credentials are not in Production | Vercel Production variables list | Only the names in the example file |
| Database has the expected tables and row level security | Run the check query from `docs/BROWSER-ONLY-SETUP.md` after applying `db/browser-setup.sql` | 8 tables, 8 with row level security |

The database is created by running `db/browser-setup.sql` once in the production Neon SQL editor (it runs in one transaction and refuses
to run twice). It only creates new tables, so it cannot change anything on the existing website.

## 3. Permanent image URLs (decision needed before anything is published)

Published pages and the feed store the full public address of every photo (`PUBLIC_MEDIA_BASE_URL` plus the file name). Changing the base
address later breaks every photo already published, so choose before the first publish. `r2.dev` addresses are development-only
(rate limited, can change, not for production). Options:

1. **Move jnrengineering.co.uk DNS to Cloudflare** (free), recreate every existing record first (website, email MX/SPF/DKIM, anything
   else on Namecheap), then add an R2 custom domain such as `media.jnrengineering.co.uk`. Best long-term, highest care: email must keep working.
2. **A separate domain used only for media**, registered or hosted on Cloudflare, with the R2 custom domain on it. No change to the main DNS. Small yearly cost (needs Rhys's approval).
3. **Another store with a permanent public address** (for example Vercel Blob or S3 behind a CDN). Needs code review of `api/_lib/s3.js` assumptions and a cost decision.

Recommendation: option 2 for the first launch (lowest risk to email and the live site), option 1 later if wanted. Whatever is chosen, test it
on staging first with synthetic photographs and keep the same address forever.

## 4. Backups and restore

- **Database (Neon):** point-in-time restore, with a history window that depends on the plan (free: short). Verify the actual window in
  the production project's settings before launch. If it is shorter than a week, either raise the plan (needs approval) or take a
  scheduled export (`pg_dump` run from Neon or a scheduled GitHub Action with a read-only role; not set up yet). **Restore drill (required before launch,
  run on the staging project):** restore to a new Neon branch from a timestamp, point a preview at it, confirm the entries appear, then delete the branch.
- **Photos (R2):** R2 has no object versioning, and a delete is permanent. The app only deletes through the defined paths (photo removal,
  abandoned uploads, cleanup scripts) and keeps originals in the private bucket until a person removes the photo. Decide whether private originals need a second copy
  (a periodic copy to another bucket). Public copies can always be regenerated from originals by re-approving the entry.
- **Audit history** is in the database and covered by the database backup.
- Write down who can run a restore (Rhys) and where the steps are (this section).

## 5. Account security and recovery

- Sign-in: passwords of 12 or more characters, stored hashed (scrypt), a lockout after repeated failures, session cookies HttpOnly, SameSite=Strict and Secure.
- **Not built yet:** two-factor sign-in and password reset by email. Until then: keep at least **two admins**, and recover a locked-out admin by an admin resetting the password on the Users page, or (if no admin can sign in) with the SQL
  method in `docs/BROWSER-ONLY-SETUP.md` (a pre-hashed password the person never types into chat).
- Offboarding: disable the user on the Users page (their sessions stop working).
- Provider accounts that can change the site: GitHub, Vercel, Neon, Cloudflare, Buffer (later), Namecheap. Turn on two-factor sign-in on each, keep recovery codes with Rhys, and keep tokens Sensitive. Rotate the R2 token and any API key if a laptop is lost.
- Approval is independent: the author and the person who made the latest content change cannot approve; only an admin can override (recorded in the audit history). Taking an entry off the website is admin-only for the first release.

## 6. Existing website regression checks

The change adds pages and rewrites but must not alter the existing site. Before merge, on the preview of the final commit, compare with
production:

1. `npm test` (includes the site wiring, security headers, quote handler and anti-spam tests) and `npm run test:browser`.
2. Every existing page returns 200 and looks the same: home, about, services, contact, quote, the other pages listed in `sitemap.xml`; the navigation and footer on each (they gained one "Our Work" link).
3. The quote form still submits and sends its email (use a test submission to a test address; no change to `api/quote.js`).
4. `/projects` still works as before: the redirect to `/our-work` is **prepared but not activated** (`npm run redirect:activate`, a separate decision after launch).
5. `robots.txt` and `sitemap.xml` unchanged except the added `sitemap-work.xml` line; `sitemap-work.xml` is empty until something is published.
6. Security headers and the content security policy still on every page; no console errors; mobile layout of the home page.
7. Core Web Vitals and page weight of the home page not worse (the home page gained a small script and a hidden section).

## 7. Rollback

- **Code:** Vercel Instant Rollback to the previous production deployment (project jnr > Deployments > the last good one > Promote / Instant Rollback). Or revert the merge commit on `main`. Both are quick and do not touch the database.
- **Database:** the change only adds tables, so older code ignores them; no rollback of the schema is needed.
- **Emergency take-down of published work without a deployment:** an admin opens each entry and uses "Take off the website" (immediate, nothing is cached). For everything at once, in the Neon SQL editor: `update entries set live_snapshot = null, live_at = null, status = case when status = 'published' then 'approved' else status end;`.
- **Switch the whole feature off:** remove the `/our-work`, `/api/feed` and `/sitemap-work.xml` rewrites from `vercel.json` and redeploy, or roll back the deployment.
- DNS and email are never touched by the launch (unless option 1 in section 3 is chosen).

## 8. Production smoke tests (after the first production deployment, website only)

Use only synthetic photographs. A test entry titled "Production smoke test, delete me" and two throw-away accounts (a workshop user and an editor) created by an admin who enters the passwords himself.

1. Sign in as admin; the dashboard loads; "Test mode" notice is **absent** (the public address is not r2.dev); the LinkedIn tick box is **absent** ("LinkedIn drafts are switched off on this site").
2. As the workshop user, on a phone, create the entry with **the synthetic GPS photo** (`test-1-landscape-gps.jpg`, which carries fake GPS data) and one more photo.
3. As the editor, tick the photos and write nothing else; as a **different** editor or an admin, approve (the editor who changed the wording cannot). Publish.
4. **GPS photo check (both sizes), before any cleanup:** from the page and `/api/feed` collect the two public addresses of the GPS photo (the 640 copy used on the list page, and the 1600 copy used on the case page, or take both from the bucket listing). Download each and confirm there is **no GPS, camera or EXIF data**
   (Claude inspects the bytes from the sandbox; the production media host needs to be allowed for that session). Record both file sizes and pixel sizes.
5. Public pages: the entry appears on `/our-work`, `/api/feed` and the sitemap; no customer name, job reference or private note anywhere; the private original address is refused to anonymous requests.
6. Permission checks 1 to 6 from the staging retest (signed out 401; workshop user cannot reach admin functions, others' entries or approve; editor cannot create users or approve their own change).
7. Take it off the website as admin: the next request to the page, feed and sitemap no longer shows it (no cache).
8. **Cleanup:** delete the test entry, then delete every object it created in both production buckets (the original and both public sizes), delete the two throw-away accounts, and confirm: entries 0, entry_images 0, both buckets empty, feed `items: []`, sitemap empty.
9. Existing website regression checks (section 6) on the live site.

## 9. Before the JNR company LinkedIn page is connected (separate, later)

- **Buffer draft image retention:** a Buffer draft points at public photo addresses, so those files are kept while a draft exists (`docs/PRODUCTION-READINESS-OPEN-ITEMS.md`). Decide how retained files are released (an admin "close publication" action, or automatic release after a set number of days) before enabling it.
- Connect the company page in Buffer, add `BUFFER_API_TOKEN`, `BUFFER_ENV=production` and `BUFFER_CHANNEL_ID_LINKEDIN` (Production only, Sensitive for the token), remove `LINKEDIN_ENABLED=false`, and repeat smoke tests 1 to 9 plus one real company-page draft read back and deleted.
