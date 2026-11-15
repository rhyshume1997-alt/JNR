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
Everything here is **staging**. Nothing touches the live JNR site, production variables, the `main` branch or any production data.
Steps marked **[Rhys's account]** can only be done by Rhys: they need his Neon (via Vercel), Cloudflare, Buffer or Vercel login, or create a secret only he should hold. Everything else is copy-and-run.

**On the computer (once)**
1. `git clone https://github.com/rhyshume1997-alt/JNR && cd JNR && git checkout feature/workshop-content && npm ci` (Node 22 or newer). *No account needed.*
2. `cp .env.staging.example .env.staging` and fill it in as you go. It is git-ignored; never commit it. It already contains `DEPLOY_ENV=staging` and the bucket names `jnr-staging-private` / `jnr-staging-public`. *No account needed.*

**Postgres: Neon via Vercel (Preview only)**
3. **[Rhys's account: Vercel]** Vercel > project `jnr` > **Storage** > **Create Database** > **Neon**. Plan **Free**. Region Europe (London) if offered. Environments: **Preview only** (untick Production and Development). If there is a setting to create a database branch for each preview deployment, turn it **off**. Connect it.
4. **[Rhys's account: Neon]** Neon dashboard > your database > **Connect** > copy the **pooled** connection string into `DATABASE_URL` in `.env.staging`.
5. `npm run migrate:staging`. *Runs on your computer against the Neon database from step 4.*
6. `CREATE_USER_PASSWORD='a long passphrase' npm run admin:create -- admin you@example.com "Your Name"`. *The passphrase is yours to choose.*

**Cloudflare R2**
7. **[Rhys's account: Cloudflare]** R2 > enable (free plan; a card is required). Copy the **Account ID** and set `S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com` (no bucket name on the end).
8. **[Rhys's account: Cloudflare]** Create two buckets named exactly `jnr-staging-private` and `jnr-staging-public` (location Western Europe). The scripts refuse any bucket name without "staging".
9. **[Rhys's account: Cloudflare]** `jnr-staging-public` > Settings > **Public Development URL** > enable. Copy the `https://pub-....r2.dev` address into `PUBLIC_MEDIA_BASE_URL` (no trailing slash). Leave `jnr-staging-private` non-public.
10. **[Rhys's account: Cloudflare]** `jnr-staging-private` > Settings > **CORS Policy** > paste `docs/r2-cors.json`. (Allows only `PUT` with `content-type`, only from the preview address.)
11. **[Rhys's account: Cloudflare, secret]** R2 > Manage API tokens > Create > **Object Read & Write**, restricted to those two buckets. Copy the Access Key ID and Secret Access Key (shown once) into `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.

**Buffer**
12. **[Rhys's account: Buffer, secret]** Create or copy a key at publish.buffer.com/settings/api into `BUFFER_API_TOKEN`. `BUFFER_STAGING_CHANNEL_ID` is already filled in (your personal LinkedIn profile). **Open item:** the key saved in the earlier session was rejected. You do not need it fixed to test the database and storage: see the next section.

**Vercel Preview variables (so the protected preview can use R2 and Buffer)**
13. **[Rhys's account: Vercel, secrets]** Project `jnr` > Settings > Environment Variables > add these, **Preview only**, secrets marked **Sensitive**: `S3_ENDPOINT`, `S3_REGION` (`auto`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_PRIVATE`, `S3_BUCKET_PUBLIC`, `PUBLIC_MEDIA_BASE_URL`, `BUFFER_API_TOKEN` (only once it works), `BUFFER_ENV` (`staging`), `BUFFER_STAGING_CHANNEL_ID`, `SITE_URL`. (`DATABASE_URL` is already there from step 3.) Then **Redeploy** the latest preview. Do **not** add `DEPLOY_ENV`; that is only for the scripts.

### Run the checks (each is independent: a rejected Buffer key blocks only the Buffer steps)
| # | Command | Needs | What it does |
|---|---|---|---|
| 14 | `npm run staging:check:services` | steps 1 to 11 | **Postgres and R2 only**, no Buffer key needed. |
| 14a | `npm run staging:check -- --only=db` or `--only=storage` | as above | Just one of them. |
| 15 | `npm run staging:e2e` | step 14 all PASS | Whole flow on your computer, website only, no Buffer. |
| 16 | `npm run staging:check` | steps 1 to 12 | Everything including Buffer (key, staging channel, schema). |
| 17 | `npm run staging:e2e -- --confirm-draft` | step 16 all PASS | The same plus one Buffer draft, read back, then **deleted**. |

Each script starts by printing exactly what it will touch (database host, bucket names, public address host, Buffer mode and channel, whether a key is present, never a secret) and ends with PASS/FAIL per line.

**What `staging:check` writes and deletes in R2 (temporary).** It writes tiny synthetic JPEGs only under the key prefix `staging-check/`: three in the private bucket (a round-trip object and two signed-upload tests) and one in the public bucket, reads them back, then deletes every one, including when a check fails part way. The last line reports "4 written and 4 deleted again". If the script is ever killed, anything left under `staging-check/` is safe to delete by hand. It never touches any other key, creates nothing in Buffer, and never contacts Vercel.

**What `staging:e2e` creates and removes.** Three throw-away users (`...@staging-e2e.invalid`), one test entry, two synthetic photographs (with fake GPS and camera data, to prove they are stripped), and, with `--confirm-draft`, one Buffer draft. Cleanup order: (1) the draft is deleted from Buffer and confirmed gone; (2) only then are the photos deleted; (3) the entry and users are deleted. The Buffer delete only targets the one draft this run created, and only if it is still an unscheduled draft on the staging channel containing this run's unique marker (`Staging test e2e...`). If the draft cannot be deleted, or a lost reply left its id unknown, the **public photos are kept** (so the draft never points at deleted images) and the script prints exact steps: delete the draft in Buffer, then delete the folder `public/<entry id>/` in the staging public bucket.

### Test the protected preview (separate from the scripts)
`staging:e2e` runs this repository's code **on your computer**. It does **not** test the deployed Vercel preview. The preview is tested separately, by hand, because it is behind Vercel Authentication and because it proves things the scripts cannot: that the Preview variables really reached the deployed functions, that the serverless functions can reach Neon and R2, and that browsers can upload to R2 from the preview address (the CORS rule).
18. **[Rhys's account: Vercel login]** On a phone, signed in to Vercel, open `https://jnr-git-feature-workshop-content-rhsys-projects.vercel.app/workshop`. Expect the amber **Test mode** notice (it appears because the public address is an r2.dev address).
19. Sign in as the admin from step 6. Record a job with **2 to 3 synthetic photographs only** (a plain wall, a table, a scrap offcut: no customer parts, drawings, screens or paperwork). Submit it.
20. In `/admin` on the preview: open the entry, tick each photo, tick LinkedIn, **Generate caption**, **Approve**, **Publish**. Expect "Published. LinkedIn: draft saved and verified" (only once the Buffer key works).
21. Pass criteria: the entry is `published`; **one** draft exists in Buffer with both images in the order you set; `/our-work` on the preview shows only that entry, with no customer, job reference or notes; opening the original photo's R2 address anonymously fails. Then delete the Buffer draft yourself, and the test entry's photos from the staging public bucket (folder `public/<entry id>/`).

### Test photographs and public media
While `PUBLIC_MEDIA_BASE_URL` is an `r2.dev` address, use **synthetic or non-sensitive photographs only**. Anything that is approved is copied to that bucket and is readable by anyone with the link; Cloudflare rate-limits the address and says it is not for production. The scripts use only generated images. **Production media hosting is a separate decision, not made here** (options above: a media domain on Cloudflare, serving through the JNR site at `/media/...`, or moving JNR's DNS). Do not put real customer photographs through staging.

### Staging never touches production
- The scripts refuse to run unless `DEPLOY_ENV` and `BUFFER_ENV` are `staging`, both bucket names contain "staging", the database address does not contain prod/production/live, `VERCEL_ENV`/`NODE_ENV` are not production, and AI captions are off. (Tested: `test/staging-safety.test.js`.)
- They never call Vercel: no project, deployment, environment-variable or domain is read or changed. A test fails if a script ever references Vercel's API or CLI.
- Every delete is on a fixed allow-list of rows the run created itself (its own test users and entry, abandoned uploads for `cleanup:orphans`), and a test fails if any other delete, drop or truncate is added.
- Staging Buffer use is limited to `BUFFER_STAGING_CHANNEL_ID` and to drafts. Neon and R2 are separate staging resources; production gets its own later.
- A variable exported in your shell overrides `.env.staging`, so if you have production values exported, open a fresh terminal. The banner shows the targets before anything runs, and the guard refuses a non-staging bucket or database name.

### Go / no-go
| Run | Go when | If not |
|---|---|---|
| `staging:check:services` (Postgres + R2) | Steps 1 to 11 done | A missing or wrong item is a FAIL line; nothing else happens |
| `staging:e2e` (website only) | Step 14 all PASS | Fix the FAIL first |
| `staging:check` (all, with Buffer) | Steps 1 to 12 done | Buffer lines FAIL; the Postgres and R2 lines are unaffected |
| `staging:e2e -- --confirm-draft` | Step 16 shows PASS for **Buffer API key** and **staging channel** | Do not run: fix the key (step 12) first |
| Preview test (steps 18 to 21) | Steps 3 to 13 done, redeployed | Do the scripts first |

## Tests
- `npm test`: see the count at the end of a run; all pass (unit, security review, end-to-end flow with real Postgres and local fakes for storage and Buffer). Database tests need `TEST_DATABASE_URL=postgres://user@localhost:5432/postgres` (a throw-away database is created and dropped per file) and are skipped without it.
- `npm run staging:selftest`: runs both staging scripts against local fakes (used to prove the scripts themselves work).
- `npm run test:browser`: 12 Chromium tests (phone form, interrupted uploads, lost replies, session expiry, permissions, failed Buffer step and recovery, public pages and leak checks, CSP). Needs Playwright.
- `node testlib/demo.js`: the whole site locally with fakes, to look at in a browser.
- The fake storage re-checks every upload signature independently; the signer matches the worked example in AWS's Signature V4 documentation.

## Vercel preview verification (2026-11-15, branch previews, no database configured yet)
- Pushing a branch **does** create a Vercel preview automatically (the `jnr` project is Git-connected; earlier branches did too). Previews live on `*.vercel.app`, and the project's Vercel Authentication covers all addresses except custom domains (`all_except_custom_domains`), so the previews with the admin system need a Vercel login. The Vercel account has two-factor sign-in on.
- The deployments built successfully. `/our-work`, `/api/feed` and `/sitemap-work.xml` are served by the new function through the rewrites, and degrade correctly with the database unconfigured: friendly 503 page, JSON, and empty XML, all `no-store`, no internals. `/workshop` serves with the security headers (CSP restricting uploads to R2, `X-Frame-Options: DENY`, `noindex`, `no-store`). `/api/admin/*` answers 401 from the function without a session (so `pg` and `sharp` load on Vercel).
- Found and fixed on the preview: with no database, the feed and sitemap returned the Our Work HTML page (error handler ignored the requested format).
- Not testable until you complete the setup steps 3 to 13: anything that needs the database, R2 or Buffer on Vercel.

## Buffer verification record
Checked on 2026-11-15 against https://developers.buffer.com/reference.html, the create-draft example and the error-handling, rate-limit and hosting-media guides:
- `createPost(input: CreatePostInput!)` with `saveToDraft`, `schedulingType: automatic`, `mode: addToQueue` is exactly the documented draft example. `PostStatus` includes `draft`.
- Read-back uses `post(input: PostInput!)` and `Post.assets` (the `Asset` interface: `type`, `mimeType`, `source`, `thumbnail`). Confirmed in the reference and by live introspection (`npm run buffer:check` passed against api.buffer.com).
- Buffer always answers HTTP 200 with coded errors; rate limits and server errors are handled by code (and the live API was seen answering `UNAUTHENTICATED` with HTTP 401 for a bad key; both are handled).
- Image URLs must be public, direct, https and permanent, and Buffer fetches them when the draft is created: the public copies are immutable and permanent.
- **Not yet done:** the authenticated calls (create a real draft, read it back) from this build environment: the saved API key was rejected as "not valid", so the live draft test is run by Rhys in steps 12, 16 and 17. This stays an open item until `staging:check` shows PASS for the Buffer API key. The earlier manual draft with an image through the Buffer connector did save and read back correctly.
