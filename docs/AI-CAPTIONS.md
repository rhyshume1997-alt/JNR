# AI-written LinkedIn posts (staging only, kill switch OFF by default)

Status: **built and tested on `feature/workshop-content`; not pushed, not deployed, not enabled anywhere.** Staging only. No production change.

## How staff use it

1. Workshop staff fill in the form as before and add **one box in their own words**: "Tell us about the job in your own words" (talk or type; private, never published).
2. John or an editor opens the entry and presses **Generate with AI** (choose to post as J.N.R. Engineering or Marpet; optional "Add my sign-off" tick).
3. A draft appears in the caption box. Edit it freely, press **Regenerate** (optionally with a few words such as "make it shorter"), or **Free template** for the plain template.
4. **Save changes**, then approve (a different person from whoever wrote the caption, unless an admin) and use the normal Buffer step. **Nothing is ever posted or scheduled automatically.** The Buffer step creates a draft only, as before.
5. Admins and editors edit the voice on the **Writing guide** page (versions, restore, examples, sign-off default). "Use as a style example" on a published post adds its approved caption to the examples.

## What goes to the AI (allow-list), and what never does

Sent: job title, short description, material, process, stage (in-production jobs only), the staff's own notes, photo descriptions someone typed, the company to post as (and its one-line note), the optional editor instruction, the writing guide with at most three examples, and the public customer label only when an admin allowed naming the customer.
Never sent: the customer's name (unless an admin allowed it), the job reference, private customer notes, internal notes, photo file names, the photos themselves, passwords or keys, anything else on the entry.

**Scanned before sending.** Blocking findings (customer name, job reference, email, phone number, purchase order) stop the request, nothing is sent, nothing is counted, and the screen says exactly what to take out. Softer findings (drawing number, tolerance, part number, a price) need a tick ("I have checked it is OK to share").
**Checked on the way back.** No invented numbers, names or claims, no customer name or job reference, no location, no hashtags, no exclamation marks. A bad draft is retried once with the reasons; if that fails, the person is shown a plain message and the free template, never the bad text. If the notes are too thin the AI asks up to three short questions instead of guessing.

## Known limits (the human approval is the real safeguard)

- The reply check catches invented numbers, capitalised names and terms, a fixed list of claim words, the customer name or job reference (case, spacing and punctuation ignored), the location, hashtags, emoji and exclamation marks. It **cannot** catch every invented lowercase fact ("for the automotive industry", "on our five-axis machine", "two" or "a dozen"). A person reads and approves every post before it is saved as a Buffer draft; nothing is posted.
- Anything the person types into the optional "change it" instruction or the notes counts as supplied, so a number or fact typed there is allowed in the post.
- Photo descriptions (typed by staff) are sent for every ready photo, cleared or not. They are scanned like the notes.
- Customer-name matching blocks the full name, the name without "Ltd", and a distinctive first word (not common words such as "marine" or "precision"). It errs on the side of blocking; an admin can allow naming the customer (tick plus a label).
- Day and month limits use UTC and are counted from the audit history. Do not purge `ai_caption_requested` rows from the audit log, or the limits reset.

## Cost controls and kill switch

- `AI_CAPTIONS_ENABLED` is **off by default**. Off means no button and no request.
- Per person per day (`AI_USER_DAILY_LIMIT`, 15) counts **presses of the button**; the automatic retry is free for the person. Whole site per day (`AI_DAILY_LIMIT`, 60) and per month (`AI_MONTHLY_LIMIT`, 600) count **every call to the AI**, retries included, so spend stays capped. Counted before each request under a lock, so failures count and two clicks at once cannot slip past. Days and months are UTC.
- Reply limited to `AI_MAX_OUTPUT_TOKENS` (400, hard ceiling 800), at most `AI_MAX_INPUT_CHARS` (6000) of text, `AI_TIMEOUT_MS` (20000) per call, small model by default (`AI_CAPTION_MODEL`, `claude-haiku-5-5`), at most two calls per press.
- Every result records tokens in and out in the audit history (never the notes or the text). The provider's own monthly spend limit is the final backstop.

## Voice (first version of the guide, from Rhys's answers)

John posts for either J.N.R. Engineering or Marpet (a fabrication company and J.N.R.'s sister company). Friendly and chatty, like talking to a friend, but authoritative and proud of the work; one short paragraph; no emoji unless the notes ask; no hashtags; never mention where the workshop is; optional sign-off (a tick, with a default John can save); customers only named when an admin allowed it, otherwise a general label from the notes; British spelling and mm; mention what the photos show only when someone described them, and let them speak. Voice is "we". No words to use or avoid were specified, so the guide has safe defaults (no prices or promises, no "best" claims, no competitors, nothing invented) that John can edit.

## Setup on staging (Rhys; no key in chat)

1. **Database:** run `db/browser-upgrade-003.sql` once in the Neon SQL editor (the staging database). Do this **before** the preview runs this code.
2. **Anthropic:** create a dedicated API key, and set a **monthly spend limit and usage alert** in the Anthropic console.
3. **Vercel (Preview only, scoped to `feature/workshop-content`):** add `ANTHROPIC_API_KEY` as **Sensitive** (Rhys enters it himself). Non-secret variables Claude in Chrome may paste: `AI_CAPTIONS_ENABLED=true` (the kill switch: remove or set `false` to switch off), and optionally `AI_USER_DAILY_LIMIT`, `AI_DAILY_LIMIT`, `AI_MONTHLY_LIMIT`.
4. Redeploy the preview. No GitHub step is needed (the tests use a fake AI service).
5. Keep it off in production until separately approved.

## Tests

`test/ai-caption.test.js` (47 tests with a fake AI service: kill switch, allow-list, key only in a header, token ceilings, confidentiality gate, checks on the reply, retry, questions, sign-off, regenerate, limits including a concurrency test, provider failures, nothing saved or sent to Buffer, approval still independent), `test/writing-guide.test.js`, and four browser tests (phone form, kill switch off, generate/edit/regenerate/save/blocked/writing guide, limit message).

## When the AI call fails
Every failed call writes one log line `ai-caption failed: {...}` and an audit record with only fixed fields: `kind`
(auth, model, rate, timeout, network, server, cut_off, refused, empty), HTTP `status`, Anthropic `error_type`,
`stop_reason`, the reply's block types (e.g. `["thinking"]`), `tokens_out`, `max_tokens`, `model`. Never the notes,
the reply text, names or the key. A reply with no text (cut off, or only a non-text block) is retried once with double
the token cap (ceiling 800), then the free template is offered.
