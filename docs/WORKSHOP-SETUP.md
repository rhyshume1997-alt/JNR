# Workshop content system: setup and status

One internal content source feeds the website (Our Work, case studies, homepage strip) and LinkedIn (as Buffer **drafts only**). Nothing is deployed to production, merged, or published to LinkedIn by this work.

Branch: `feature/workshop-content` (never merged to `main`). Security review: `docs/SECURITY-REVIEW.md`. Tolra: `docs/TOLRA-INTEGRATION.md` (disabled).

## How it works
1. Staff open `/workshop` on a phone, sign in, record a job (in production, completed or workshop update) with title, short description, material, process, stage and photos. Customer details are private and optional.
2. Photos go straight to **private** storage with a signed link; the server checks each file and rejects drawings and CAD files by content. Originals stay private.
3. An editor reviews in `/admin`: edits, orders photos, ticks each photo as checked, chooses destinations, writes or generates the caption, then **approves**. Approval runs the confidentiality checks and only then creates public copies (resized, all EXIF/GPS removed).
4. **Publish** is a separate click. The website shows the approved snapshot; LinkedIn gets a **draft in Buffer** (`saveToDraft: true`) that the server reads back to verify caption, image list and order. You publish from Buffer.

States: `draft`, `pending_approval`, `approved`, `rejected`, `published`, `failed`. Roles: `workshop`, `editor`, `admin`.

## What changed on the site
- `Our Work` is in the nav, mobile menu and footer of every existing page (`/our-work` shows "new work soon" and is `noindex` until something is published).
- `/sitemap-work.xml` (listed in `robots.txt`) is generated: it is empty until something is published, so an empty page is never in a sitemap. The static `sitemap.xml` is untouched.
- **`/projects` redirect is prepared, not active.** When `/our-work` is ready: `npm run redirect:activate` (or `-- --check` to preview) makes `/projects`, `/projects/` and `/work` redirect (301) to `/our-work`, then deploy as normal. It is idempotent and tested.
- Homepage: a "Recent work" strip appears only when something is published.

## Hosting plan and costs
Checked in the Vercel dashboard by Rhys: the team that owns the `jnr` project ("rhsy's projects", `rhsys-projects`) is on an **active Pro plan** (billing period 24 Oct to 24 Nov, card on file). Nothing is transferred, bought or changed. (An earlier reading of "Hobby" came from a stale account-level billing field and was wrong.)

| Part | Cost to start |
|---|---|
| Vercel | Already covered by the Pro plan. The workshop system adds 2 functions and no cron jobs. |
| Postgres | **Neon free plan** through Vercel Storage, Preview only. $0. |
| Photos | **Cloudflare R2**, free up to 10 GB (a card must be on file). A photo is about 4 MB, so 10 GB is roughly 2,500 photos. |
| Buffer | The Free plan includes an API key (150 requests per 15 minutes, 600 a day). Each publish uses about 2 requests. Buffer's reference says drafts skip posting-limit checks. |
| AI captions | Off. Free template captions. |

**Public image address.** For staging the public bucket uses R2's own address (`https://pub-....r2.dev`). That is fine for the tests, but Cloudflare rate-limits it and says it is not for production. R2 custom domains only work for a domain whose DNS is on Cloudflare, and `jnrengineering.co.uk` uses Namecheap DNS, so `media.jnrengineering.co.uk` is **not** available without moving DNS. Decide before go-live (not needed now): (a) a small separate domain on Cloudflare for media, (b) serve images through the JNR site at `/media/...` with a Vercel rewrite to the public bucket, which keeps a permanent address on the JNR domain, or (c) move JNR's DNS to Cloudflare. Buffer needs the URLs to be public, direct, https and permanent.

## Setup: exact steps, in order (about 30 minutes)
Everything is staging only. Nothing here touches the live JNR site, production variables or `main`.

**On your computer (once)**
1. `git clone https://github.com/rhyshume1997-alt/JNR && cd JNR && git checkout feature/workshop-content && npm ci` (Node 22 or newer).
2. `cp .env.staging.example .env.staging`. You will fill it in as you go. It is git-ignored; never commit it.

**Postgres: Neon via Vercel (Preview only)**
3. Vercel > project `jnr` > **Storage** > **Create Database** > **Neon**. Plan: **Free**. Region: Europe (London) if offered. Environments: tick **Preview only** (untick Production and Development). If you see a setting to create a database branch for each preview deployment, turn it **off**: staging should use one shared database. Connect it.
4. Neon dashboard > your database > **Connect** > copy the **pooled** connection string into `DATABASE_URL` in `.env.staging`.
5. `npm run migrate:staging` (creates the tables, with row level security on).
6. `CREATE_USER_PASSWORD='a long passphrase' npm run admin:create -- admin you@example.com "Your Name"`.

**Cloudflare R2**
7. Cloudflare dashboard > **R2** > enable (free plan, card required). Note the **Account ID** (R2 overview page). Set `S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com` in `.env.staging` (no bucket name on the end).
8. Create two buckets: `jnr-private` and `jnr-public` (location: Western Europe). Put the names in `S3_BUCKET_PRIVATE` and `S3_BUCKET_PUBLIC`.
9. `jnr-public` > Settings > **Public Development URL** > enable. Copy the `https://pub-....r2.dev` address into `PUBLIC_MEDIA_BASE_URL` (no trailing slash). Leave `jnr-private` with public access **off**.
10. `jnr-private` > Settings > **CORS Policy** > Edit > paste the contents of `docs/r2-cors.json` (allows only `PUT` with `content-type`, only from the preview address).
11. R2 > **Manage API tokens** > Create API token > permission **Object Read & Write**, restricted to those two buckets. Copy the **Access Key ID** and **Secret Access Key** into `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. (The secret is shown once.)

**Buffer**
12. Open the Buffer API key page (publish.buffer.com/settings/api), create or copy a key, and put it in `BUFFER_API_TOKEN`. `BUFFER_STAGING_CHANNEL_ID` is already filled in: it is your personal LinkedIn profile. Open item: the key saved in the earlier session was rejected as "not valid". Step 14 will say clearly whether this key works.

**Vercel Preview variables (so the protected preview can use R2 and Buffer)**
13. Vercel > project `jnr` > **Settings** > **Environment Variables** > add these with **only Preview ticked**, marking the secret ones **Sensitive**: `S3_ENDPOINT`, `S3_REGION` (`auto`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_PRIVATE`, `S3_BUCKET_PUBLIC`, `PUBLIC_MEDIA_BASE_URL`, `BUFFER_API_TOKEN`, `BUFFER_ENV` (`staging`), `BUFFER_STAGING_CHANNEL_ID`, `SITE_URL`. (`DATABASE_URL` is already there from step 3.) Then push any change to the branch, or **Redeploy** the latest preview, so it picks them up.

**Run the checks (in this order)**
14. `npm run staging:check`: read-only. Every line should say PASS. A FAIL line says exactly what to fix.
15. `npm run staging:e2e`: the whole flow with the website only (no Buffer): users, phone-style upload to R2, caption, approval, publish, public-image and leak checks, then cleans up.
16. `npm run staging:e2e -- --confirm-draft`: the same plus **one draft** on your personal LinkedIn via Buffer, read back, with both images checked. Delete that draft in Buffer afterwards (its id is printed).
17. Phone test on the protected preview (sign in to Vercel first): `https://jnr-git-feature-workshop-content-rhsys-projects.vercel.app/workshop`. Record a job with 2 to 3 photos. In `/admin`: tick the photos, tick LinkedIn, Generate caption, Approve, Publish. Check Buffer for one draft with the images, and `/our-work` on the preview for only the approved entry.

### Go / no-go for the real-service tests
| Run | Go when | If not |
|---|---|---|
| `staging:check` | Steps 1 to 13 are done. It is read-only (it writes two tiny files to R2 and deletes them) and creates nothing in Buffer. | A missing item is reported as a FAIL, nothing else happens. |
| `staging:e2e` (no flag) | `staging:check` shows PASS for Postgres, row level security, private bucket is private, signed upload, CORS and public image URL. | Fix the FAIL it names first. |
| `staging:e2e -- --confirm-draft` | The check also shows PASS for **Buffer API key** and **staging channel** (this is the open key item). | Do not run it. Re-create the Buffer key and repeat step 12. |
Both scripts refuse to run unless `BUFFER_ENV=staging`, refuse if AI captions are on, only ever use the one staging channel, and can only create drafts.

## Tests
- `npm test`: 136 tests (unit, security review, end-to-end flow with real Postgres and local fakes for storage and Buffer). Database tests need `TEST_DATABASE_URL=postgres://user@localhost:5432/postgres` (a throw-away database is created and dropped per file) and are skipped without it.
- `npm run staging:selftest`: runs both staging scripts against local fakes (used to prove the scripts themselves work).
- `npm run test:browser`: 12 Chromium tests (phone form, interrupted uploads, lost replies, session expiry, permissions, failed Buffer step and recovery, public pages and leak checks, CSP). Needs Playwright.
- `node testlib/demo.js`: the whole site locally with fakes, to look at in a browser.
- The fake storage re-checks every upload signature independently; the signer matches the worked example in AWS's Signature V4 documentation.

## Vercel preview verification (2026-11-15, branch previews, no database configured yet)
- Pushing a branch **does** create a Vercel preview automatically (the `jnr` project is Git-connected; earlier branches did too). Previews live on `*.vercel.app`, and the project's Vercel Authentication covers all addresses except custom domains (`all_except_custom_domains`), so the previews with the admin system need a Vercel login. The Vercel account has two-factor sign-in on.
- The deployments built successfully. `/our-work`, `/api/feed` and `/sitemap-work.xml` are served by the new function through the rewrites, and degrade correctly with the database unconfigured: friendly 503 page, JSON, and empty XML, all `no-store`, no internals. `/workshop` serves with the security headers (CSP restricting uploads to R2, `X-Frame-Options: DENY`, `noindex`, `no-store`). `/api/admin/*` answers 401 from the function without a session (so `pg` and `sharp` load on Vercel).
- Found and fixed on the preview: with no database, the feed and sitemap returned the Our Work HTML page (error handler ignored the requested format).
- Not testable until you complete steps 1 to 4: anything that needs the database, R2 or Buffer on Vercel.

## Buffer verification record
Checked on 2026-11-15 against https://developers.buffer.com/reference.html, the create-draft example and the error-handling, rate-limit and hosting-media guides:
- `createPost(input: CreatePostInput!)` with `saveToDraft`, `schedulingType: automatic`, `mode: addToQueue` is exactly the documented draft example. `PostStatus` includes `draft`.
- Read-back uses `post(input: PostInput!)` and `Post.assets` (the `Asset` interface: `type`, `mimeType`, `source`, `thumbnail`). Confirmed in the reference and by live introspection (`npm run buffer:check` passed against api.buffer.com).
- Buffer always answers HTTP 200 with coded errors; rate limits and server errors are handled by code (and the live API was seen answering `UNAUTHENTICATED` with HTTP 401 for a bad key; both are handled).
- Image URLs must be public, direct, https and permanent, and Buffer fetches them when the draft is created: the public copies are immutable and permanent.
- **Not yet done:** the authenticated calls (create a real draft, read it back) from this build environment: the saved API key was rejected as "not valid", so the live draft test is run by Rhys in steps 12 to 16. This stays an open item until `staging:check` shows PASS for the Buffer API key. The earlier manual draft with an image through the Buffer connector did save and read back correctly.
