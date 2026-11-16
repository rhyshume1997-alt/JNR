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

## First administrator without a terminal
A static page (`/admin/first-admin`) hashes the password in the person's own browser (PBKDF2-SHA256, 600,000 rounds) and produces SQL that creates the user only if there are no users yet. No server route is added, no bootstrap token exists, the page makes no network request (browser-tested), and the password is never typed into a chat. The server accepts that hash format and replaces it with scrypt at the first sign-in. **The page is temporary:** `npm run premerge:check` fails while it (or its script files) exist, and it is removed from the branch once the admin has signed in, before any merge.

## GitHub Action for staging checks (reviewed 2026-11-16 against secret exposure)
Threat: the branch can be changed by more than one person or tool, so a commit that edits the workflow or a script could try to read the staging credentials, relying on the owner approving a run without seeing the code.
| Risk | Control | Pinned by |
|---|---|---|
| A pushed branch change reaches the credentials | Credentials are **environment** secrets in `staging`, which accepts deployments **only from tags `staging-*`**. No branch can use it, even with a modified workflow. No repository-level secrets. | `ci-workflow.test.js` (tag-only trigger, no branch reference) |
| Someone creates a tag at an unreviewed commit | A repository ruleset with an **empty bypass list** restricts creating, moving and deleting `staging-*` tags. The bypass list is empty on purpose: GitHub shows pushes made from the Claude Code session as Rhys's own account (`actor: rhyshume1997-alt` on workflow run 1), so an admin bypass could admit them. Rhys disables the ruleset for seconds to create each tag. A probe must show a tag push being refused before any credential is stored. | probe (manual, step 10) |
| Rhys approves a run without knowing what code runs | He checks the 40-character commit on the run page against the approved SHA before approving. A tag is bound to one commit; the first step of the job stops unless the commit equals `APPROVED_SHA`, an environment variable only Rhys can set, and it runs **before** any repository code. The tag name must match its commit. Required-reviewer approval stays on. | `ci-workflow.test.js`, `ci-mode` tests |
| Dependencies run with the credentials | `npm ci --ignore-scripts` from the committed lockfile (46 packages, every one with an integrity hash, none from outside the npm registry, no install script runs). The install and planning steps receive **no** secrets. Exact versions pinned. `npm audit` for production dependencies: **0 vulnerabilities** (after the fix below). | audit run; lockfile check |
| Actions or caches tampered with | Both actions pinned to full commit SHAs (checkout v4.4.0, setup-node v4.4.0). No cache is used. `persist-credentials: false`. Read-only token. | `ci-workflow.test.js` |
| Script injection | No `${{ }}` expression inside any `run:` script; values reach scripts as environment variables only. | `ci-workflow.test.js` |
| Over-broad credentials | Each mode is its own step with only what it needs: `services` and `e2e` never receive the Buffer token. Nothing for Vercel or production. | `ci-workflow.test.js` |
| Errors and public logs | The repository is public, so logs are public. The scripts install an output scrubber over the **whole process** (their own lines, `console.error` from the application code they run, uncaught errors and stack traces) removing database host, user and password, the R2 address, key ids, the Buffer token and channel, and the public media host. GitHub also masks exact secret values. Step-debug logging must stay off. | `ci-workflow.test.js` (including a real child process that logs secrets) |
Residual risk: the SHA check lives in the tagged commit's own workflow file, so it protects only if the tag ruleset holds and Rhys checks the commit before approving; neither the ruleset nor the approval can distinguish Rhys from Claude in Chrome acting in his browser session, so **Rhys must click the approval himself** after reading the SHA. The pinned action SHAs and the npm packages are trusted at the versions chosen; a compromise of an exact pinned release or of the npm registry content before the lockfile was written is not prevented. Anyone with **admin** rights to the repository (Rhys) can change the ruleset, environment or `APPROVED_SHA`; the controls are meant to stop a non-admin writer, not the owner.

## Dependency review (2026-11-16)
`npm audit` found **1 high** advisory group in `sharp` 0.34.5 (libvips, libheif and librsvg vulnerabilities), the library that decodes uploaded photos. Upgraded to **`sharp` 0.35.5** (exact version), audit now reports 0 vulnerabilities; all tests, including the EXIF/GPS-stripping and file-type tests, pass. `pg` and `busboy` are pinned to exact versions as well.

## Vercel Preview variables
Every Preview variable added for staging, and the Neon variables created by the integration, are scoped to the branch `feature/workshop-content` only, not to all preview branches, so previews of other branches cannot read the database or storage credentials. Verified read-only through the Vercel API (see the status message).

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
