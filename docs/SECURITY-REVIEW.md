# Security review (before anything goes online)

Reviewed 2026-11-15 on branch `feature/workshop-content`. Scope: authentication, permissions, private storage, public image approval, secret handling. Each item names the test that keeps it true. Run them all with `npm test` (database tests need `TEST_DATABASE_URL`) and `npm run test:browser`.

## Authentication
| Check | Result |
|---|---|
| Passwords | scrypt N=65536, r=8, p=1 with a random salt per user, parameters stored with the hash. Minimum 12 characters. (`security.test.js`) |
| Sessions | 256-bit random token in an HttpOnly, SameSite=Strict cookie, Secure on Vercel whatever the environment says. Only a SHA-256 of the token is stored. 12 hour expiry. Disabling a user or resetting a password ends their sessions. |
| Guessing | Same message for unknown email and wrong password, same work done for both (no timing hint). Account locks for 15 minutes after 5 failures. **Added in review:** 20 failures per address in 10 minutes blocks that address, which stops guessing across many accounts. |
| CSRF | State-changing requests need a same-origin `Origin` and an `X-Requested-With` header, on top of SameSite=Strict. (`workshop.flow.test.js`) |
| Not included | Two-factor sign-in, emailed password resets. Passwords are reset by an admin. Recommended before many staff use it. |

## Permissions
| Check | Result |
|---|---|
| Roles | workshop < editor < admin, enforced on the server for every route, not just hidden in the page. Workshop staff only ever see and change their own entries, and only before approval. (`workshop.flow.test.js`, `security.test.js`, browser tests) |
| Approval | An editor cannot approve their own entry; an admin can. |
| Audit history | **Changed in review:** editors and admins only (it names other staff). |
| Users | Admin only. An admin cannot disable or demote themselves. |
| Injection | Every query is parameterised. Column names only come from a fixed validated list. IDs that are not UUIDs are rejected. Search text and SQL in fields are plain text. (`security.test.js`) |
| Output | Public pages escape every field. The dashboard builds its pages with `textContent`. The admin pages have a Content-Security-Policy with no inline script and no inline style. (`render.test.js`, `site-wiring.test.js`, browser tests: zero CSP violations) |

## Private storage
| Check | Result |
|---|---|
| Originals | Stored byte for byte in a private bucket under server-generated names. Nothing user-supplied (file name, title) ever becomes part of a storage key. |
| Browser uploads | Short-lived (10 minute) signed link per file. The content type is signed, and **added in review:** the exact size is signed too, so a link cannot be used to upload something larger. The server re-checks type (from the bytes), size and image validity afterwards and deletes anything that fails. |
| Private means private | `npm run staging:check` makes an anonymous request for a private object and fails if it is readable. |
| Database | **Added in review (migration 002):** row level security is on for every table and any API-role grants are removed, so a hosted provider's public data API (for example Supabase's) can read nothing even if it is switched on. `staging:check` verifies this on the real database. |
| Upload CORS | The private bucket must allow `PUT` from the site only (rule in `WORKSHOP-SETUP.md`). The page's `connect-src` allows uploads only to `*.r2.cloudflarestorage.com`, not to any https host. |
| Abandoned uploads | `npm run cleanup:orphans` removes unfinished uploads older than 24 hours. |

## Public image approval
| Check | Result |
|---|---|
| Nothing public before approval | The public bucket is written only at approval. Before that the only copies are private. (`security.test.js`) |
| Every photo is cleared by a person | A photo not ticked "no drawings, screens or customer details" is never published. Approval stops and says so. |
| What is published | A re-encoded JPEG at most 1600 px (and a 640 px thumbnail) with all EXIF, GPS, camera, owner and original file name data removed, under an immutable name that includes a content hash. Tested with a photo carrying fake GPS and camera data. |
| Public text | Approval is blocked if the public text contains the customer name, job reference, email, phone number or PO number, and asks for confirmation on drawing numbers, revisions, tolerances and part-number-like text. Only an admin can allow naming a customer. |
| Edits after approval | The public site and the Buffer draft use the approved snapshot. Editing an approved entry sends it back to draft and does not change what is live until it is approved and published again. |

## Secrets
| Check | Result |
|---|---|
| Where they live | Environment variables only (Vercel project settings). `.env*` files are git-ignored; `.env.example` holds names only. Nothing is read in the browser. |
| Buffer | `BUFFER_API_TOKEN` is used only on the server. It is not in any response, error, audit record or log (`security.test.js`, browser tests). |
| Failing dependencies | Database, storage and Buffer errors return a generic message; details go to server logs only, and connection strings are scrubbed from the scripts' output. |
| Scripts | `create-user.js` reads the password from the environment, not the command line. `staging-check` and `staging-e2e` never print a secret and use throw-away users with random passwords. |
| Cloudflare R2 keys | Use a key scoped to the two buckets, not an account-wide key. |

## Buffer cannot publish or schedule
`assertDraftOnly` runs before every request and refuses `saveToDraft: false`, any `dueAt`, and any `mode` other than `addToQueue` (`buffer.guard.test.js`). Staging can only target `BUFFER_STAGING_CHANNEL_ID`; production refuses to run without `BUFFER_CHANNEL_ID_LINKEDIN`. Buffer's own documentation says drafts are not published "until explicitly scheduled" and skip posting-limit checks.

## First administrator without a terminal, and the GitHub Action
- **First admin:** a static page (`/admin/first-admin`) hashes the password in the person's own browser (PBKDF2-SHA256, 600,000 rounds) and produces SQL that creates the user only if there are no users yet. No server route is added, no bootstrap token exists, and the page makes no network request (browser-tested). The server accepts that hash format and replaces it with scrypt at the first sign-in. The page is removed from the branch before any merge.
- **GitHub Action:** triggers only on the feature branch when `staging-run/request.txt` is edited (or manually), never on pull requests or forks; read-only token; secrets live in a `staging` environment that needs Rhys's approval and only in the final step; `npm ci --ignore-scripts`; hosts, ids and keys are scrubbed from every printed line because the repository is public. Pinned by `test/ci-workflow.test.js`.

## Staging scripts
Refuse to run unless explicitly staging (`DEPLOY_ENV`, `BUFFER_ENV`, bucket names containing "staging", no prod-looking database address, no production `VERCEL_ENV`), never call Vercel, only delete rows and objects they created themselves, and use synthetic photographs only. The Buffer test draft is deleted (and confirmed gone) before its images, and only if it is an unscheduled draft on the staging channel carrying the run's unique marker. All pinned by `test/staging-safety.test.js`.

## Findings fixed during this review
1. No per-address sign-in throttle -> added.
2. Password hashing cost below current guidance -> raised.
3. Audit history visible to workshop staff -> restricted.
4. Signed upload links did not pin file size -> pinned.
5. Hosted-Postgres public data API could expose tables if enabled -> row level security and revoked grants.
6. Content-Security-Policy allowed uploads to any https host -> restricted to R2 (found by the browser tests).
7. Buffer coded errors (rate limit returned as HTTP 200) were not retried; a lost reply on a server error could have been retried unsafely -> fixed.
8. Cookie could be sent without `Secure` if a local override leaked into Vercel -> forced on.
9. A signed-out session part way through the form lost what was typed -> form is kept.
10. The database connection skipped TLS certificate verification for remote hosts -> now verified by default (Neon uses a public CA); `DATABASE_SSL_VERIFY=false` is an explicit opt-out for hosts with a private CA.

## Still open
- Two-factor sign-in and password reset emails.
- `connect-src` is tied to R2; change it in `vercel.json` if you use another store.
- Buffer's authenticated API could not be exercised from the build environment (see `WORKSHOP-SETUP.md`).
