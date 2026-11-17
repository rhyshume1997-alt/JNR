# One-page post tool (`/post`)

John's everyday page: photos, rough notes, **Write my post** (AI), edit, **Save as LinkedIn draft in Buffer**.

- Buffer gets a **draft only**. Nothing is scheduled or posted; John presses Post in Buffer.
- The website is a separate optional tick. Photos need one "I have checked these photos" tick.
- Behind the page it is the same backend: confidentiality scan before the AI is called, EXIF/GPS stripping, audit records,
  daily/monthly AI limits, kill switch `AI_CAPTIONS_ENABLED` (default off). Nothing was removed.
- John (admin) approves his own draft in this one step (`POST /api/admin/entries/:id/save-draft`: submit + approve + publish).
  If someone else wrote or last edited the content, the existing admin-override audit record is written.
- Workshop staff still use `/workshop`; their updates appear under "Waiting for you" for John. Workshop role cannot open `/post`.
- One press of Write my post counts as one of the user's drafts; the automatic retry counts toward the site-wide limits only.
- The full dashboard (`/admin`) and writing guide are unchanged and still reachable.
- No database change is needed.
