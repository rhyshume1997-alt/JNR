# Workshop content system: setup

One internal content source feeds the website (Our Work, case studies, homepage strip) and LinkedIn (as Buffer **drafts only**).
Nothing here is deployed or switched on until you do the steps below. Nothing in this document costs money until you create the accounts it names.

## How it works

1. Workshop staff open `/workshop` on a phone, sign in, and record a job: title, short description, material, process, stage, photos, optional private customer details. Type is *in production*, *completed* or *workshop update*.
2. Photos go **straight from the phone to private storage** with a short-lived signed link. The server then checks each file (real file type from its bytes, decodes it, size, minimum dimensions) and rejects drawings, CAD files and corrupt images. Originals are kept untouched and private.
3. An editor reviews in `/admin`: edits text, orders photos, ticks each photo as checked, picks destinations, writes or generates the LinkedIn caption, then **approves**. Approval runs the confidentiality checks and only then creates public copies (resized, all EXIF/GPS removed) with permanent URLs.
4. Publishing is a separate click. The website shows the approved snapshot. LinkedIn gets a **draft in Buffer** (`saveToDraft: true`), which the server reads back to verify the caption and images. You publish from Buffer yourself.

Statuses: `draft`, `pending_approval`, `approved`, `rejected`, `published`, `failed`. Editing anything that was already approved sends it back to `draft`, but the public site keeps showing the last approved version until the new one is approved and published.

Roles: `workshop` (own entries, before approval), `editor` (everything except users, un-publishing and naming customers), `admin` (all). You cannot approve your own entry unless you are an admin.

## What is never published automatically

Customer name, job reference, customer notes, internal notes, original photos and anything in a photo you have not ticked as checked. Approval is blocked if the public text contains the customer name, job reference, an email address, a phone number or a PO number. It asks for confirmation when it sees drawing numbers, revisions, tolerances or part-number-like text. Only an admin can allow a customer to be named.

## Costs (confirm before enabling)

| Part | Suggested | Cost to start | Notes |
|---|---|---|---|
| Hosting | existing Vercel project | whatever JNR pays now | Vercel's free Hobby plan is for non-commercial use. Check which plan JNR is on. This adds 2 functions (limit is 12). No cron jobs are used. |
| Database | Supabase or Neon, Postgres | free tier | Free projects can pause when idle (Supabase after about a week). First request after a pause is slow. |
| Photo storage | Cloudflare R2 (S3-compatible) | free up to 10 GB | Needs a card on file. Originals are large: about 4 MB a photo, so 10 GB is roughly 2,500 photos. Supabase Storage's free 1 GB would fill in a few months. Any S3-compatible store works. |
| Buffer | existing account | $0 if your plan includes API access | I could not check Buffer's plan rules for the API from the build environment. Confirm API access and whether drafts count toward the free plan's post limit. |
| AI captions | off | $0 while off | Optional paid API. Roughly a fraction of a penny per caption with a small model, but confirm the price. The free template generator is the default. |

## Setup steps

1. **Database.** Create a Postgres project. Copy the *pooled* connection string into `DATABASE_URL`. Run `npm install` then `DATABASE_URL=... npm run migrate`.
2. **Storage.** Create two buckets: a **private** one and a **public** one. Put a custom domain on the public bucket (for example `media.jnrengineering.co.uk`). R2's `r2.dev` address is rate limited and not for production. Create an access key limited to those two buckets. Set the `S3_*` variables and `PUBLIC_MEDIA_BASE_URL`.
   Add this CORS rule to the **private** bucket so phones can upload directly (replace the origin, and add your preview URL if you test there):
   ```json
   [{"AllowedOrigins":["https://jnrengineering.co.uk"],"AllowedMethods":["PUT"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":3600}]
   ```
3. **First admin.** `CREATE_USER_PASSWORD='a long passphrase' DATABASE_URL=... node scripts/create-user.js admin you@example.com "Your Name"`. Then add staff in `/admin` > Users. Passwords need 12+ characters. Five wrong passwords lock the account for 15 minutes.
4. **Buffer.** Create an API token in Buffer. Set `BUFFER_API_TOKEN`. Set `BUFFER_ENV=staging` and `BUFFER_STAGING_CHANNEL_ID` to the connected personal LinkedIn profile. In staging the server can *only* use that channel. Run `BUFFER_API_TOKEN=... npm run buffer:check -- --channels <organizationId>` to confirm the schema and list channel ids (see "Not verified" below).
5. **Vercel.** Add the variables from `.env.example` to *Preview* only first. Do not put production values in until staging has been tested. Review `vercel.json` (new rewrites and admin/workshop headers).
6. **Staging test.** Open `/workshop`, submit a job with two photos, approve and publish it from `/admin`, then open Buffer and check there is one draft with the images. Nothing should be on LinkedIn.
7. **Go live for JNR.** Connect JNR's LinkedIn page in Buffer, set `BUFFER_CHANNEL_ID_LINKEDIN`, then change `BUFFER_ENV` to `production`. Until then the personal profile is the only target.

## Local development and tests

`npm test` runs everything. The database tests need a Postgres server: `TEST_DATABASE_URL=postgres://user@localhost:5432/postgres npm test` (it creates and drops a throw-away database per test file). Without it those tests are skipped and say so. Storage, Buffer and the caption service are local fakes in `testlib/harness.js`; the tests never touch the internet. The fake storage re-checks every upload signature independently, and the signer matches the worked example in the AWS Signature V4 documentation.

`node testlib/demo.js` starts the whole site locally with the fakes, for looking at the pages in a browser.

## Safety properties (each has a test)

- Buffer calls can only create drafts: `assertDraftOnly` refuses `saveToDraft: false`, any `dueAt`, and any `mode` other than `addToQueue`.
- Staging can only ever use the staging channel; production refuses to run without its own channel id.
- Idempotency: creating an entry twice with the same key makes one entry. Publishing the same caption and photos again does not make a second Buffer draft (unique key on entry, channel and content hash).
- Retries: rate limits and refused connections are retried with backoff. A request that may have reached Buffer (timeout, dropped connection, 5xx) is **not** retried: it becomes `uncertain`, and a person checks Buffer and either links the draft they find or allows a retry. This prevents duplicate LinkedIn drafts.
- Read-back: after saving, the draft is read from Buffer and must match the approved caption, image list and order, be a draft, have no scheduled or sent time, and be on the right channel.
- Audit: sign-ins, edits (field names only for private fields), approvals, publishing and failures are recorded with who and when.

## Not verified (please read)

- **Buffer's schema.** I could not reach `developers.buffer.com` from the build environment. The create-draft call follows Buffer's documented `createPost` example (endpoint `https://api.buffer.com`, `saveToDraft`, typed `assets` array, `PostActionSuccess | MutationError`). The read-back query, `post(input: {id})`, and the asset field names are my best reading and are **untested against the live API**. `npm run buffer:check` compares them with the live schema without changing anything; if something differs, every query is in one object (`QUERIES` in `api/_lib/buffer.js`). The earlier manual test through the connected Buffer tool did confirm a draft with an image saves and reads back.
- **Vercel specifics.** The rewrites in `vercel.json`, the 30 second function limit, and `sharp` running in Vercel's runtime have not been exercised on Vercel. Test on a preview deployment first.
- **Real storage.** Uploads were tested against a fake that verifies signatures, not against R2 or Supabase. The bucket CORS rule above is the usual cause of a failed first upload.
- **Not included:** two-factor sign-in, email password resets (an admin resets passwords in Users), and automatic cleanup of public image copies (kept deliberately, because a published page or LinkedIn draft may point at them). Add the new Our Work link to the nav of the existing static pages after approval. The existing `/projects/` placeholder is untouched; decide whether it should redirect to `/our-work`. Add the new pages to `sitemap.xml` once there are real entries. Mention staff photos and accounts in `privacy.html` if needed.
