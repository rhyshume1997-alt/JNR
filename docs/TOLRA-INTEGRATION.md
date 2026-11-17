# Optional future Tolra integration (read only)

Status: designed and stubbed, **off by default**, and Tolra is not modified by any of this.

## Goal

Let the workshop form pre-fill or suggest the production **stage** for a job from Tolra, using the job reference the entry already holds. Nothing else.

## Design rules

1. **Job reference is the only join key.** `entries.job_ref` is private and never published. Tolra is looked up by it; no Tolra id is stored.
2. **No direct ERP access.** This site never connects to Tolra's database. The Tolra side exposes one dedicated read-only endpoint, `GET /jobs/{ref}/stage`, that already returns only `{ "status": "<word>" }`. Whatever else Tolra knows (customer, price, drawings, notes) cannot leave because the endpoint does not return it.
3. **Allow-list on this side too.** `api/_lib/tolra.js` maps a fixed list of Tolra status words to this site's stages (`STAGE_MAP`) and drops everything else, including unknown statuses. It does not guess.
4. **Suggest, never write.** The result is shown as a suggestion (`POST /api/admin/entries/:id/stage-suggestion`) that an editor accepts. Tolra data is not stored and cannot publish anything by itself.
5. **Fail quiet.** 4 second timeout; any error returns `null`. Tolra being down never blocks the form.
6. **Separate credential, read-only.** `TOLRA_READ_TOKEN` is a token that can call only that endpoint. `TOLRA_ENABLED` must be `true` and a URL set before anything is called.
7. **One-way coupling.** This site depends on a tiny contract (`/jobs/{ref}/stage` returning `status`). Tolra does not know this site exists.

## To switch it on later

On the Tolra side: add the read-only stage endpoint and a token that can reach only it. Then set `TOLRA_ENABLED=true`, `TOLRA_READ_URL`, `TOLRA_READ_TOKEN`, and edit `STAGE_MAP` to Tolra's real status words. Covered by `test/tolra.test.js`, which checks that extra fields in the reply (customer, price, drawing) are discarded and odd job references are never sent.
