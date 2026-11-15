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
| Part | Finding | Cost |
|---|---|---|
| Vercel | The `jnr` project is on **Hobby** (checked). Hobby is Vercel's personal, non-commercial plan, and JNR is a business, so the site arguably should be on **Pro (about $20/user/month)** regardless of this work. This adds 2 functions (limit 12) and no cron jobs. Preview protection (Vercel Authentication) is on and works on Hobby. | $0 more on Hobby; Pro is your call |
| Postgres | The Supabase organization I could reach ("QuoteFlow") is on the paid Pro plan with three projects, so a new project there would bill extra. I did not create one. Use a **new free Supabase organization/project** (or Neon free). | $0 |
| Photos | Cloudflare R2, free up to 10 GB (needs a card on file). A photo is about 4 MB, so 10 GB is roughly 2,500 photos. | $0 to start |
| Buffer | The Free plan includes an API key (1 key, 150 requests per 15 minutes, 600 a day). Each publish uses about 2 requests. Buffer's reference says drafts skip posting-limit checks. | $0 |
| AI captions | Off. Free template captions are used. | $0 |

## Exact setup actions (staging)
1. **Postgres (free).** Create a free Supabase org + project in London (or Neon). Copy the *pooled* connection string. Then: `DATABASE_URL=... npm ci && npm run migrate`.
2. **Cloudflare R2.** Create two buckets: `jnr-private` (no public access) and `jnr-public`. Put a custom domain on the public bucket (for example `media.jnrengineering.co.uk`). Do not use `r2.dev` (rate limited), and make sure no bot-protection or WAF challenge applies to that media domain: Buffer fetches the image itself when the draft is created. Create an API token limited to those two buckets (Object Read & Write). Add this CORS rule to the **private** bucket:
   ```json
   [{"AllowedOrigins":["https://jnr-git-feature-workshop-content-rhsys-projects.vercel.app"],"AllowedMethods":["PUT"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":3600}]
   ```
   (for production use `https://jnrengineering.co.uk`).
3. **Buffer.** Create an API key at publish.buffer.com/settings/api. The staging channel is your personal LinkedIn profile, id `6afa05fbece6dfde5fd74165` (from the earlier test).
4. **Vercel, Preview scope only** (Project Settings > Environment Variables). Do not set Production yet. Names are in `.env.example`:
   `DATABASE_URL`, `SITE_URL` (the preview URL), `S3_ENDPOINT` (`https://<account>.r2.cloudflarestorage.com`), `S3_REGION=auto`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_PRIVATE`, `S3_BUCKET_PUBLIC`, `PUBLIC_MEDIA_BASE_URL`, `BUFFER_API_TOKEN`, `BUFFER_ENV=staging`, `BUFFER_STAGING_CHANNEL_ID`. Leave `AI_CAPTIONS_ENABLED`, `TOLRA_ENABLED` unset. Mark the secrets Sensitive.
5. **First admin.** `CREATE_USER_PASSWORD='long passphrase' DATABASE_URL=... node scripts/create-user.js admin you@example.com "Your Name"`.
6. **Verify the real services**, from your computer with the same variables exported:
   - `npm run staging:check` (read-only: database, row level security, private bucket is private, signed upload, CORS, public URL for automated fetchers, Buffer key, channel, schema). Set `STAGING_ORIGIN` to the preview URL to test CORS from it.
   - `npm run staging:e2e -- --confirm-draft` runs the whole flow with throw-away users and one clearly named test entry, creates **one draft** in Buffer on the staging channel, reads it back, checks both images are attached and in order, checks the public images are anonymous and metadata-free, checks no private marker appears anywhere public, then deletes its test data. Delete the draft in Buffer afterwards (its id is printed).
7. **Phone test on the preview.** Open `https://jnr-git-feature-workshop-content-rhsys-projects.vercel.app/workshop` on your phone (sign in to Vercel first, that is the access protection), add a job with 2 to 3 photos, then in `/admin`: tick the photos, tick LinkedIn, Generate caption, Approve, Publish. Open Buffer: one draft with the images. Open `/our-work` on the preview: only the approved entry, none of the private details.
8. **Go-live for JNR** (only with your approval): connect JNR's LinkedIn page in Buffer, set Production variables and `BUFFER_CHANNEL_ID_LINKEDIN`, set `BUFFER_ENV=production`, run `npm run redirect:activate`, merge.

## Tests
- `npm test`: 126 tests (unit, security review, end-to-end flow with real Postgres and local fakes for storage and Buffer). Database tests need `TEST_DATABASE_URL=postgres://user@localhost:5432/postgres` (a throw-away database is created and dropped per file) and are skipped without it.
- `npm run test:browser`: 12 Chromium tests (phone form, interrupted uploads, lost replies, session expiry, permissions, failed Buffer step and recovery, public pages and leak checks, CSP). Needs Playwright.
- `node testlib/demo.js`: the whole site locally with fakes, to look at in a browser.
- The fake storage re-checks every upload signature independently; the signer matches the worked example in AWS's Signature V4 documentation.

## Buffer verification record
Checked on 2026-11-15 against https://developers.buffer.com/reference.html, the create-draft example and the error-handling, rate-limit and hosting-media guides:
- `createPost(input: CreatePostInput!)` with `saveToDraft`, `schedulingType: automatic`, `mode: addToQueue` is exactly the documented draft example. `PostStatus` includes `draft`.
- Read-back uses `post(input: PostInput!)` and `Post.assets` (the `Asset` interface: `type`, `mimeType`, `source`, `thumbnail`). Confirmed in the reference and by live introspection (`npm run buffer:check` passed against api.buffer.com).
- Buffer always answers HTTP 200 with coded errors; rate limits and server errors are handled by code (and the live API was seen answering `UNAUTHENTICATED` with HTTP 401 for a bad key; both are handled).
- Image URLs must be public, direct, https and permanent, and Buffer fetches them when the draft is created: the public copies are immutable and permanent.
- **Not yet done:** the authenticated calls (create a real draft, read it back) from this build environment: the saved API key was rejected as "not valid", so the live draft test has to be run by you with step 6. The earlier manual draft with an image through the Buffer connector did save and read back correctly.
