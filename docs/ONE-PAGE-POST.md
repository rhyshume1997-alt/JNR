# One-page post tool (`/post`)

John's everyday page: photos, rough notes, **Write my post** (AI), edit, **Save as LinkedIn draft in Buffer**.

- Buffer gets a **draft** by default. John then schedules or posts it in Buffer himself.
- **Scheduling is opt-in and admin only.** Tick "Schedule it", pick a date and time (always UK time), press "Review and schedule", then confirm
  "Schedule this post for <exact time> (UK time)?". Only then does the server send it, as a Buffer *scheduled* post (`mode customScheduled` with `dueAt`,
  at least 5 minutes ahead and within a year; never post-now, next-in-queue or the queue). The server requires the confirmed time to match, reads the post
  back from Buffer and checks status `scheduled` and the time (a mismatch is shown as failed, never as scheduled). Buffer then posts it by itself at that time;
  John can change or delete it in Buffer. The time is never stored in the entry, so staff and the dashboard's Publish button can only ever make drafts.
  If the post is already in Buffer (draft or scheduled), scheduling is refused so a second post cannot be created beside it.
- There is no website option on this page. Photos need one "I have checked these photos" tick because resized copies go to the public bucket for Buffer to fetch.
- Storage needs both buckets (two different ones) and the public photo address, or nothing starts.
- Behind the page it is the same backend: confidentiality scan before the AI is called, EXIF/GPS stripping, audit records,
  daily/monthly AI limits, kill switch `AI_CAPTIONS_ENABLED` (default off). Nothing was removed.
- John (admin) approves his own draft in this one step (`POST /api/admin/entries/:id/save-draft`: submit + approve + publish).
  If someone else wrote or last edited the content, the existing admin-override audit record is written.
- Workshop staff still use `/workshop`; their updates appear under "Waiting for you" for John. Workshop role cannot open `/post`.
- One press of Write my post counts as one of the user's drafts; the automatic retry counts toward the site-wide limits only.
- The full dashboard (`/admin`) and writing guide are unchanged and still reachable.
- No database change is needed.
