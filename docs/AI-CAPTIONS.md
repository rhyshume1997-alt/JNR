# AI-written LinkedIn posts (staging only, kill switch OFF by default)

Status: **in progress on `feature/workshop-content`, not deployed, not enabled anywhere.** Built and tested on staging only. No production change.

## What is built so far

1. **Private box on every entry: "Tell us about the job in your own words"** (up to 4000 characters). Workshop staff type or dictate it on the form; the office can edit it in the dashboard.
   It is private: never published, never in the website, the feed, the snapshot or the audit history (which records the field name only). Changing it does not send an approved entry back to draft.
2. **The JNR writing guide**, an editable setting (editors and admins; every save is a version; restore is a new version). First version written from Rhys's answers (see below). Includes three clearly labelled **SAMPLE structures** (placeholders only, no facts), a "use as a style example" action that adds the approved caption of a published post, and a check that nothing confidential can be saved into the guide (it is sent with every request).
3. **Database upgrade** `db/browser-upgrade-003.sql` (a settings table, its history, and the notes column). For a database that already ran `db/browser-setup.sql`: paste it into the Neon SQL editor once. It refuses to run twice or on a database without the first setup. A fresh database gets everything from `db/browser-setup.sql`.

## Still to build (in this order)

4. The server-side AI call: allow-list of fields, scan before sending, blocked when anything looks confidential, post-checks on the reply (no invented numbers, names or claims, no customer name), reply or up to three questions when the notes are too thin.
5. Cost controls: kill switch `AI_CAPTIONS_ENABLED` (default off), per-user and daily limits counted from the audit history, output limit, request timeout, monthly cap.
6. The editor screen: **Generate with AI**, editable draft, **Regenerate**, optional sign-off tick (John saves a default), choose JNR or Marpet, Writing guide page.
7. Tests with a fake AI provider, browser tests, a short real-API check from the protected preview, independent review.

## Rhys's voice answers (the first version of the guide follows these)

- John posts for either J.N.R. Engineering or Marpet (chosen per post; edit the one-line note about Marpet in the guide).
- Friendly and chatty, like talking to a friend, but authoritative and proud of the work. (The guide shows pride through the job itself and forbids claims about the company that were not supplied.)
- One short paragraph. No emoji unless the notes ask. No hashtags. Never mention where the workshop is.
- Sign-off optional: a tick when generating, with a default John can save.
- Customers: named only if an admin has allowed it; otherwise "a customer", the industry, or what the part is for, using only what the notes say.
- British spelling, millimetres. Mention what the photos show (only when described) and let them speak.
- No words to use or avoid were specified: the guide has safe defaults (no prices or promises, no "best" claims, no competitors, nothing invented) that John can edit.
- Assumed, please correct in the guide if wrong: "we" rather than "I".
