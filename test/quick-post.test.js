'use strict';
// "Save as LinkedIn draft": the one-click path behind John's single page (fake Buffer, no cost, no network).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const H = require('../testlib/harness');

const SKIP = H.BASE ? false : 'set TEST_DATABASE_URL to a Postgres server to run the database tests';
const PW = 'correct horse battery staple';
const CAPTION = 'We turned a run of brackets this week and took light cuts on the thin wall. Photos below.';

describe('one-click save to a Buffer draft (database, fake Buffer)', { skip: SKIP }, () => {
  let db, s3, buf, app, john, editor, editor2, work, query;
  before(async () => {
    db = await H.createTestDb(); s3 = await H.startFakeS3(); buf = await H.startFakeBuffer(); H.setEnv(s3, buf);
    app = await H.startApp(); query = require('../api/_lib/db').query;
    const auth = require('../api/_lib/auth'); const boss = { email: 'seed@test' };
    for (const [email, role] of [['john@jnr.test', 'admin'], ['editor@jnr.test', 'editor'], ['editor2@jnr.test', 'editor'], ['work@jnr.test', 'workshop']]) await auth.createUser(boss, { email, name: email.split('@')[0], role, password: PW });
    john = app.client(); editor = app.client(); editor2 = app.client(); work = app.client();
    for (const [c, e] of [[john, 'john@jnr.test'], [editor, 'editor@jnr.test'], [editor2, 'editor2@jnr.test'], [work, 'work@jnr.test']]) assert.strictEqual((await c.login(e, PW)).status, 200);
  });
  after(async () => { await app.close(); await s3.close(); await buf.close(); await db.drop(); });
  beforeEach(() => { buf.state.posts.clear(); buf.state.calls.length = 0; buf.state.mode = 'ok'; buf.state.failures = 0; });

  let colour = 0x400000;
  async function newEntry(client, fields, photos) {
    const r = await client.post('/entries', Object.assign({ kind: 'update', title: 'Brackets for a boat', summary: 'Brackets for a boat', rough_notes: 'Made brackets. Thin wall.', destinations: { website: false, linkedin: false } }, fields || {}), { 'idempotency-key': crypto.randomUUID() });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data)); const id = r.data.entry.id;
    for (let i = 0; i < (photos === undefined ? 1 : photos); i++) {
      const up = await H.uploadImage(client, id, await H.jpegWithExif(1200, 800, '#' + (colour += 0x1111).toString(16).padStart(6, '0')), 'image/jpeg', 'p' + i + '.jpg');
      assert.strictEqual(up.finalize.status, 200, JSON.stringify(up.finalize.data));
    }
    return id;
  }
  const save = (client, id, body) => client.post('/entries/' + id + '/save-draft', Object.assign({ caption: CAPTION, clear_photos: true, use_caption_as_summary: true }, body || {}));
  const posts = () => [...buf.state.posts.values()];
  const creates = () => buf.state.calls.filter((c) => /createPost/.test(c.query));

  describe('John (admin): one press, one Buffer DRAFT, nothing posted', () => {
    it('saves the post as a draft in Buffer with the photos in order, no schedule, and verifies it by reading it back', async () => {
      const id = await newEntry(john, {}, 2);
      const r = await save(john, id);
      assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.status, 'published');
      assert.deepStrictEqual(r.data.results.map((x) => [x.destination, x.status]), [['linkedin', 'verified']]);
      assert.strictEqual(posts().length, 1); const p = posts()[0];
      assert.strictEqual(p.status, 'draft'); assert.strictEqual(p.dueAt, null); assert.strictEqual(p.text, CAPTION); assert.strictEqual(p.assets.length, 2);
      const input = creates()[0].variables.input; assert.strictEqual(input.saveToDraft, true); assert.ok(!('dueAt' in input) || input.dueAt == null, 'no schedule time was sent');
      assert.ok(buf.state.calls.some((c) => /query|post\(/i.test(c.query) && !/createPost/.test(c.query)), 'the draft was read back');
    });
    it('does not put anything on the website unless the separate tick is on', async () => {
      const id = await newEntry(john, { title: 'Private to LinkedIn only' }); await save(john, id);
      assert.ok(!(await (await fetch(app.origin + '/our-work')).text()).includes('Private to LinkedIn only'));
      assert.ok(!(await (await fetch(app.origin + '/api/feed')).json()).items.some((i) => i.title === 'Private to LinkedIn only'));
      assert.strictEqual((await query('select live_snapshot from entries where id = $1', [id])).rows[0].live_snapshot, null);
    });
    it('with the website tick on, publishes there too (separately verified), using the approved post as the public text', async () => {
      const id = await newEntry(john, { title: 'On both job', rough_notes: 'PRIVATE-NOTE-7712 for the team only' }); const r = await save(john, id, { website: true });
      assert.deepStrictEqual(r.data.results.map((x) => x.destination).sort(), ['linkedin', 'website']);
      const feed = (await (await fetch(app.origin + '/api/feed')).json()).items.find((i) => i.title === 'On both job');
      assert.ok(feed, 'on the website'); assert.ok(CAPTION.startsWith(feed.summary.slice(0, 40)), 'the public description is the approved post: ' + feed.summary);
      const page = await (await fetch(app.origin + '/our-work')).text(); assert.ok(!page.includes('PRIVATE-NOTE-7712'), 'the private notes never reach the website');
    });
    it('pressing it twice does not make a second draft', async () => {
      const id = await newEntry(john); await save(john, id); const again = await save(john, id);
      assert.strictEqual(again.status, 200); assert.strictEqual(again.data.already, true); assert.strictEqual(posts().length, 1); assert.strictEqual(creates().length, 1);
    });
    it('after editing the post, saving again makes a NEW draft (the old one stays in Buffer to delete) and says it is published again', async () => {
      const id = await newEntry(john); await save(john, id);
      const r = await save(john, id, { caption: CAPTION + ' Edited.' }); assert.strictEqual(r.data.status, 'published'); assert.strictEqual(posts().length, 2);
    });
    it('records John approving his own work in the audit history (the existing override), and the whole path in order', async () => {
      const id = await newEntry(john); await save(john, id);
      const rows = (await query("select action, detail from audit_log where entry_id = $1 order by id", [id])).rows;
      const actions = rows.map((r) => r.action);
      for (const want of ['entry_created', 'entry_updated', 'entry_submitted', 'entry_approved', 'buffer_draft_requested', 'buffer_draft_created', 'buffer_draft_verified', 'entry_published']) assert.ok(actions.includes(want), 'missing ' + want + ': ' + actions.join());
      assert.strictEqual(rows.find((r) => r.action === 'entry_approved').detail.independent_approval_overridden, true);
    });
    it('uses the existing photo safeguard: unticked photos stop it, ticked ones go through', async () => {
      const id = await newEntry(john);
      const blocked = await save(john, id, { clear_photos: false }); assert.strictEqual(blocked.status, 422); assert.strictEqual(blocked.data.error, 'images_not_cleared'); assert.strictEqual(posts().length, 0);
      const ok = await save(john, id, { clear_photos: true }); assert.strictEqual(ok.data.status, 'published');
    });
    it('a post with no photos can still be saved as a text draft', async () => {
      const id = await newEntry(john, { title: 'Text only job' }, 0); const r = await save(john, id); assert.strictEqual(r.data.status, 'published'); assert.strictEqual(posts()[0].assets.length, 0);
    });
  });

  describe('the existing checks still apply behind the single button', () => {
    it('stops confidential text with the same plain findings, saves nothing to Buffer, and works after the text is fixed', async () => {
      const id = await newEntry(john);
      const bad = await save(john, id, { caption: CAPTION + ' Email buyer@zeta.com about the PO 4500012345.' });
      assert.strictEqual(bad.status, 422); assert.strictEqual(bad.data.error, 'blocked'); assert.ok(bad.data.blocking.some((b) => b.code === 'email')); assert.strictEqual(posts().length, 0);
      const fixed = await save(john, id); assert.strictEqual(fixed.data.status, 'published'); assert.strictEqual(posts().length, 1);
    });
    it('asks for a tick on softer findings, then goes ahead', async () => {
      const id = await newEntry(john); const cap = CAPTION + ' Machined to drawing 4471-B.';
      const ask = await save(john, id, { caption: cap }); assert.strictEqual(ask.status, 422); assert.strictEqual(ask.data.error, 'needs_acknowledgement');
      const keys = ask.data.warnings.map((w) => w.code + ':' + w.field); assert.ok(keys.length >= 1); assert.strictEqual(posts().length, 0);
      const ok = await save(john, id, { caption: cap, acknowledge: keys }); assert.strictEqual(ok.data.status, 'published'); assert.strictEqual(posts().length, 1);
    });
    it('refuses an empty post and an over-long post before touching anything', async () => {
      const id = await newEntry(john); assert.strictEqual((await save(john, id, { caption: '   ' })).status, 422); assert.strictEqual((await save(john, id, { caption: 'x'.repeat(3001) })).status, 422);
      assert.strictEqual((await query('select status from entries where id = $1', [id])).rows[0].status, 'draft');
    });
    it('a Buffer failure is reported as not finished, nothing is claimed as saved, and pressing again completes it without a duplicate', async () => {
      const id = await newEntry(john); buf.state.mode = 'mutation-error'; buf.state.failures = 99;
      const r = await save(john, id); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.status, 'failed'); assert.strictEqual(posts().length, 0);
      assert.strictEqual((await query('select status from entries where id = $1', [id])).rows[0].status, 'failed');
      buf.state.mode = 'ok'; buf.state.failures = 0;
      const again = await save(john, id); assert.strictEqual(again.data.status, 'published'); assert.strictEqual(posts().length, 1);
    });
    it('says so plainly when Buffer is not connected on the site, without changing the entry', async () => {
      const was = process.env.BUFFER_API_TOKEN; delete process.env.BUFFER_API_TOKEN;
      try { const id = await newEntry(john); const r = await save(john, id); assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'linkedin_disabled'); assert.match(r.data.message, /Buffer is not connected/); assert.strictEqual(posts().length, 0); }
      finally { process.env.BUFFER_API_TOKEN = was; }
    });
  });

  describe('everyone else keeps the old safeguards', () => {
    it('workshop staff cannot use it, and signed-out visitors are refused', async () => {
      const id = await newEntry(work); assert.strictEqual((await save(work, id)).status, 403); assert.strictEqual((await save(app.client(), id)).status, 401);
    });
    it('an editor who is not an admin cannot approve their own entry or their own change: someone else must', async () => {
      const own = await newEntry(editor); const a = await save(editor, own); assert.strictEqual(a.status, 403); assert.match(a.data.message, /Someone else needs to approve/); assert.strictEqual(posts().length, 0);
      const staff = await newEntry(work, { title: 'Staff update' });
      assert.strictEqual((await work.post('/entries/' + staff + '/submit')).status, 200);
      const b = await save(editor, staff); assert.strictEqual(b.status, 403); assert.match(b.data.message, /you made the latest change/);
      assert.strictEqual((await editor2.post('/entries/' + staff + '/approve', {})).status, 200, 'a second person can approve what the editor changed');
    });
    it('John can check and send what a workshop colleague submitted: the same single button, still recorded', async () => {
      const staff = await newEntry(work, { title: 'From the workshop', rough_notes: 'Made some brackets for a boat. Thin wall.' }, 2);
      assert.strictEqual((await work.post('/entries/' + staff + '/submit')).status, 200);
      const r = await save(john, staff, { use_caption_as_summary: false }); assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.status, 'published');
      const row = (await query("select created_by, status from entries where id = $1", [staff])).rows[0]; assert.strictEqual(row.status, 'published');
      assert.strictEqual(posts().length, 1); assert.strictEqual(posts()[0].assets.length, 2);
    });
  });

  describe('scheduling (opt-in, admin only, confirmed, future, scheduled mode only, read back)', () => {
    const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
    const sched = (client, id, at, extra) => save(client, id, Object.assign({ schedule_at: at, confirm_schedule_at: at }, extra || {}));
    it('schedules for the confirmed time: one scheduled post, mode customScheduled, never post-now or queue, read back and verified', async () => {
      const id = await newEntry(john, {}, 2); const at = inHours(48);
      const r = await sched(john, id, at);
      assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.status, 'published'); assert.strictEqual(r.data.scheduled_for, new Date(at).toISOString());
      assert.deepStrictEqual(r.data.results.map((x) => [x.destination, x.status]), [['linkedin', 'verified']]);
      assert.strictEqual(posts().length, 1); const p = posts()[0];
      assert.strictEqual(p.status, 'scheduled'); assert.strictEqual(p.dueAt, new Date(at).toISOString()); assert.strictEqual(p.assets.length, 2);
      const input = creates()[0].variables.input; assert.strictEqual(input.mode, 'customScheduled'); assert.strictEqual(input.saveToDraft, false); assert.strictEqual(input.dueAt, new Date(at).toISOString());
      assert.ok(!['shareNow', 'shareNext', 'addToQueue', 'recommendedTime'].includes(input.mode));
      assert.ok(buf.state.calls.some((c) => !/createPost/.test(c.query)), 'read back from Buffer');
      const actions = (await query("select action, detail from audit_log where entry_id = $1 order by id", [id])).rows;
      for (const want of ['buffer_schedule_requested', 'buffer_scheduled_created', 'buffer_scheduled_verified']) assert.ok(actions.some((a) => a.action === want), 'missing ' + want);
      assert.ok(actions.some((a) => a.detail && a.detail.scheduled_for === new Date(at).toISOString()), 'the audit record carries the time');
    });
    it('without a schedule it is still a plain draft (the default)', async () => {
      const id = await newEntry(john); await save(john, id);
      assert.strictEqual(posts()[0].status, 'draft'); assert.strictEqual(creates()[0].variables.input.saveToDraft, true);
    });
    it('needs the time to be confirmed: no confirmation, or a different time, sends nothing to Buffer', async () => {
      const id = await newEntry(john); const at = inHours(48);
      for (const body of [{ schedule_at: at }, { schedule_at: at, confirm_schedule_at: inHours(49) }, { schedule_at: at, confirm_schedule_at: 'nope' }]) {
        const r = await save(john, id, body); assert.strictEqual(r.status, 422, JSON.stringify(r.data)); assert.strictEqual(r.data.error, 'confirm_required');
      }
      assert.strictEqual(creates().length, 0); assert.strictEqual((await query('select status from entries where id = $1', [id])).rows[0].status, 'draft');
    });
    it('refuses a time in the past, less than 5 minutes ahead, over a year ahead, or without a time zone; nothing is sent', async () => {
      const id = await newEntry(john);
      for (const at of [inHours(-1), inHours(0.05), inHours(24 * 400), '2031-01-01T09:00', 'tomorrow', '2031-02-30T09:00:00Z']) {
        const r = await sched(john, id, at); assert.strictEqual(r.status, 422, at + ' ' + JSON.stringify(r.data));
      }
      assert.strictEqual(creates().length, 0);
    });
    it('is admin only: an editor is refused, and nothing is changed or sent', async () => {
      const id = await newEntry(editor); const at = inHours(48);
      const r = await sched(editor, id, at); assert.strictEqual(r.status, 403); assert.strictEqual(r.data.error, 'admin_only');
      assert.strictEqual(creates().length, 0); assert.ok(!(await query('select caption from entries where id = $1', [id])).rows[0].caption, 'nothing was saved');
    });
    it('a staff member cannot slip a schedule in through the entry itself: the dashboard publish button only ever makes a draft', async () => {
      const id = await newEntry(work, {}); await work.post('/entries/' + id + '/submit');
      const pr = await john.patch('/entries/' + id, { caption: CAPTION, destinations: { website: false, linkedin: true, schedule_at: inHours(48) } }); assert.strictEqual(pr.status, 200, JSON.stringify(pr.data));
      assert.ok(!('schedule_at' in (pr.data.entry.destinations || {})), 'a schedule is never stored in the entry'); const img = (await john.get('/entries/' + id)).data.images; for (const i of img) await john.patch('/images/' + i.id, { cleared_for_public: true });
      const ap = await john.post('/entries/' + id + '/approve', {}); assert.strictEqual(ap.status, 200, JSON.stringify(ap.data)); const pub = await john.post('/entries/' + id + '/publish', {});
      assert.strictEqual(pub.status, 200, JSON.stringify(pub.data)); assert.strictEqual(posts()[0].status, 'draft'); assert.strictEqual(creates()[0].variables.input.saveToDraft, true);
    });
    it('does not create a second post next to one already in Buffer, even if the post was edited; nothing is changed', async () => {
      const id = await newEntry(john); await save(john, id);                       // a draft is already in Buffer
      const r = await sched(john, id, inHours(48), { caption: CAPTION + ' Edited.' });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.data.error, 'already_in_buffer'); assert.strictEqual(posts().length, 1); assert.strictEqual(posts()[0].status, 'draft');
      assert.strictEqual((await query('select caption from entries where id = $1', [id])).rows[0].caption, CAPTION, 'the entry was not changed either');
      const id2 = await newEntry(john); assert.strictEqual((await sched(john, id2, inHours(48))).status, 200);
      const again = await sched(john, id2, inHours(72)); assert.strictEqual(again.status, 409); assert.strictEqual(posts().length, 2);
    });
    it('if Buffer holds the post for a different time or as sent, the read-back fails and says so (never shown as scheduled)', async () => {
      const id = await newEntry(john); buf.state.mutate = (p) => { p.dueAt = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(); };
      try { const r = await sched(john, id, inHours(48)); assert.strictEqual(r.data.status, 'failed'); assert.match(JSON.stringify(r.data.results), /not the time that was confirmed/); } finally { buf.state.mutate = null; }
      const id2 = await newEntry(john); buf.state.mutate = (p) => { p.status = 'sent'; p.sentAt = new Date().toISOString(); };
      try { const r = await sched(john, id2, inHours(48)); assert.strictEqual(r.data.status, 'failed'); assert.match(JSON.stringify(r.data.results), /sent/); } finally { buf.state.mutate = null; }
    });
  });

  it('the list shows who sent each item, so John can see what is waiting for him', async () => {
    const id = await newEntry(work, { title: 'Waiting item' }); await work.post('/entries/' + id + '/submit');
    const list = (await john.get('/entries?status=pending_approval')).data.entries; const mine = list.find((e) => e.id === id);
    assert.ok(mine); assert.strictEqual(mine.created_by_name, 'work');
  });
});
