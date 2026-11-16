# Finish staging setup from a browser (no terminal, no npm)

Feature branch only. Nothing is merged, nothing is live, nothing touches production.
Tags: **[RHYS]** only Rhys can do it (his accounts, card, secrets, password, phone). **[CLAUDE]** Claude in Chrome can drive it (clicking, copying public text, pasting non-secrets). Claude never types a key, token or password.

Already done: Vercel Pro confirmed; Neon database connected (Preview only, London).

## 1. Create the database tables (Neon SQL editor)
1. **[CLAUDE]** Open https://github.com/rhyshume1997-alt/JNR/blob/feature/workshop-content/db/browser-setup.sql and press **Copy raw file**. (File: `db/browser-setup.sql`. It is generated from the migrations, contains no secrets, and a test proves it builds exactly the same database as `npm run migrate`.)
2. **[CLAUDE]** Vercel > project `jnr` > Storage > the Neon store > **Open in Neon** > **SQL Editor**. Choose database `neondb`. Paste the whole file. Press **Run**.
3. **[CLAUDE]** Expect success with no rows. If it says "JNR setup has already been run... Nothing was changed", it was already done; carry on.
4. **[CLAUDE]** Check: run `select count(*) filter (where relrowsecurity) as rls_on, count(*) as tables from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r';` Expect `8` and `8`.

## 2. Create the first administrator (no scripts, password never in chat)
Chosen because it adds **no new server route**: a one-time route would need a bootstrap token and a public sign-up endpoint. Instead a static page hashes the password inside Rhys's own browser tab (PBKDF2, 600,000 rounds), makes no network request, and gives SQL that holds only the salted hash. The server accepts that hash and replaces it with its stronger scrypt hash at the first sign-in. The SQL only creates a user if there are no users yet, so pasting it twice or later does nothing.
5. **[RHYS]** In a browser signed in to Vercel, open `https://jnr-git-feature-workshop-content-rhsys-projects.vercel.app/admin/first-admin` (wait for the latest preview to finish building).
6. **[RHYS types, Claude must not read or type this]** Email, name, a password of 14+ characters (a few random words), the same password again. Press **Make the SQL**. The password boxes clear themselves.
7. **[CLAUDE]** Press **Copy SQL** (the page never needs to be read), open the Neon SQL editor, paste, **Run**. Expect `INSERT 0 1`.
8. **[RHYS]** Open `/admin` on the preview and sign in with the email and password just chosen. Done. Close the first-admin page.
Note: Neon keeps a query history containing the salted hash (not the password). You can delete that history entry. Before merging, this page is removed from the branch.

## 3. Run staging:check and staging:e2e from GitHub instead (no laptop)
Yes. A GitHub Action (`.github/workflows/staging-checks.yml`) runs the same scripts. **Cost: none.** The repo is public, so standard GitHub runners are free; a run takes 1 to 3 minutes. It is not a Vercel step (Vercel builds are the wrong place for this).
It cannot start by itself: it runs only on the feature branch, only when `staging-run/request.txt` is edited (GitHub's manual "Run workflow" button only appears for workflows on the default branch, so we avoid needing a merge), and only after Rhys approves in the `staging` environment. Never for pull requests, forks or schedules. Secrets go to the final step only. **Logs of a public repo are public**, so the scripts print no secrets and shorten hosts and ids (tested).
9. **[RHYS]** GitHub > repo JNR > Settings > Environments > **New environment** `staging`. Required reviewers: Rhys (untick "prevent self-review" if shown). Deployment branches: **Selected** > `feature/workshop-content`.
10. **[RHYS pastes; CLAUDE can navigate]** In that environment add **Secrets**: `DATABASE_URL` (the Neon **pooled** string from Neon > Connect), `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and later `BUFFER_API_TOKEN`.
11. **[CLAUDE]** Same page, **Variables** (not secret): `S3_BUCKET_PRIVATE=jnr-staging-private`, `S3_BUCKET_PUBLIC=jnr-staging-public`, `PUBLIC_MEDIA_BASE_URL` (the `pub-….r2.dev` address), `BUFFER_STAGING_CHANNEL_ID=6afa05fbece6dfde5fd74165`, `STAGING_ORIGIN=https://jnr-git-feature-workshop-content-rhsys-projects.vercel.app`.
12. **[CLAUDE]** To run: open `staging-run/request.txt` on the feature branch, pencil icon, change `mode: none` to the mode, **Commit directly to feature/workshop-content**. Open Actions > the new run > **Review deployments**. **[RHYS]** tick `staging` > **Approve and deploy**. **[CLAUDE]** read the PASS/FAIL lines and report them.
13. Order: `services` (Postgres + R2, no Buffer key) > `e2e` (whole website flow) > `check` (adds Buffer) > `e2e-draft` (one Buffer draft, deleted afterwards). `e2e-draft` only after `check` shows PASS for the Buffer API key and staging channel. After a run, set the mode back to `none`.
(This runs the repo's code on GitHub's runner against the real services. It does not test the deployed preview: that is section 5.)

## 4. Cloudflare R2 and Vercel variables
14. **[RHYS]** Cloudflare > R2 > enable (the subscription/card click). Note the Account ID.
15. **[CLAUDE]** Create buckets `jnr-staging-private` and `jnr-staging-public`; on the public one enable **Public Development URL** (copy the `pub-….r2.dev` address); on the private one paste `docs/r2-cors.json` into the CORS policy (https://github.com/rhyshume1997-alt/JNR/blob/feature/workshop-content/docs/r2-cors.json).
16. **[RHYS]** R2 > Manage API tokens > create a token (**Object Read & Write**, only those two buckets). The secret shows once: Rhys copies the Access Key ID and Secret himself into GitHub (step 10) and Vercel (step 18).
17. **[CLAUDE]** Vercel > `jnr` > Settings > Environment Variables: paste the block from `docs/vercel-preview-env.example` (fill the two blanks first), **Preview only**.
18. **[RHYS]** Add as **Sensitive**, Preview only: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and (once the key works) `BUFFER_API_TOKEN`. Then **[CLAUDE]** Redeploy the latest preview.
Open item: the Buffer key from the earlier session was rejected. **[RHYS]** create a fresh key at publish.buffer.com/settings/api; only Rhys pastes it.

## 5. Test the real protected preview (separate from step 3)
Use **synthetic photographs only** (a plain wall, a table, a scrap offcut; no customer parts, drawings, screens or paperwork): the public photo address is an `r2.dev` link that anyone with it can open.
19. **[RHYS, on his phone]** Sign in to vercel.com in the phone browser (that is the access protection). Open `https://jnr-git-feature-workshop-content-rhsys-projects.vercel.app/workshop`. Expect the amber **Test mode** notice.
20. **[RHYS]** Sign in with the admin account. Pick **Completed**, title `Staging test 16 Nov`, a one-line description, material `Aluminium 6082`, process `CNC milling`. **Add photos** > take or choose 2 to 3 synthetic photos. Leave "Ready for review" ticked. **Save update**. Expect "Saved" and "Sent to the office for approval".
21. **[CLAUDE or RHYS, desktop browser signed in to Vercel]** `/admin` > open the entry > tick **Checked** under every photo > use the arrows to put them in the order wanted > tick **LinkedIn** > **Generate caption** (check it names no customer) > **Approve** > **Publish**. Expect "Published. LinkedIn: draft saved and verified in Buffer. Nothing was posted."
22. **Pass criteria:** the entry shows `published`; Buffer holds **one** draft with all the photos in the order set; `/our-work` on the preview shows only this entry; nothing about a customer or job reference appears; opening the original photo's R2 address without credentials fails.
23. **Clean up:** **[RHYS]** delete the draft in Buffer. **[CLAUDE]** in R2 delete the folders `public/<entry id>/` (public bucket) and `originals/<entry id>/` (private bucket); in `/admin` press **Take off the website** (admin).
