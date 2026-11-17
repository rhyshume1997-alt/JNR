'use strict';
// Launch-readiness changes: nothing public is cached; approval must be independent (also of whoever changed the entry last);
// publishing cannot race with removing a photo; a published entry that went back to draft is shown as still live; LinkedIn can be
// switched off for a website-only launch.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const H = require('../testlib/harness');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function browserApi() {
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'assets/api.js'), 'utf8'), { window: win, document: {}, console, setTimeout, XMLHttpRequest: function () {} });
  return win.JNR;
}

const SKIP = H.BASE ? false : 'set TEST_DATABASE_URL to a Postgres server to run the database tests';
const PW = 'correct horse battery staple';

describe('launch readiness (database)', { skip: SKIP }, () => {
  let db, s3, buf, app, admin, editor, editor2, work, E, P, query;
  before(async () => {
    db = await H.createTestDb(); s3 = await H.startFakeS3(); buf = await H.startFakeBuffer(); H.setEnv(s3, buf);
    app = await H.startApp();
    E = require('../api/_lib/entries'); P = require('../api/_lib/publish'); query = require('../api/_lib/db').query;
    const auth = require('../api/_lib/auth');
    const boss = { email: 'seed@test' };
    for (const [email, role] of [['admin@jnr.test', 'admin'], ['editor@jnr.test', 'editor'], ['editor2@jnr.test', 'editor'], ['work@jnr.test', 'workshop']]) await auth.createUser(boss, { email, name: email.split('@')[0], role, password: PW });
    admin = app.client(); editor = app.client(); editor2 = app.client(); work = app.client();
    for (const [c, e] of [[admin, 'admin@jnr.test'], [editor, 'editor@jnr.test'], [editor2, 'editor2@jnr.test'], [work, 'work@jnr.test']]) assert.strictEqual((await c.login(e, PW)).status, 200);
  });
  after(async () => { await app.close(); await s3.close(); await buf.close(); await db.drop(); });

  const base = (o) => Object.assign({ kind: 'completed', title: 'Stainless flange set', summary: 'Batch of flanges turned and drilled.', material: '316 stainless steel', process: 'CNC turning', stage: 'delivered' }, o || {});
  let colour = 0x300000;
  const photo = (w, h) => H.jpegWithExif(w || 1200, h || 800, '#' + (colour += 0x1111).toString(16).padStart(6, '0'));
  async function entry(client, fields) {
    const e = await client.post('/entries', base(fields), { 'idempotency-key': crypto.randomUUID() });
    assert.strictEqual(e.status, 201, JSON.stringify(e.data));
    return e.data.entry.id;
  }
  async function photoOn(client, id, tick) {
    const up = await H.uploadImage(client, id, await photo(), 'image/jpeg', 'IMG_' + crypto.randomBytes(3).toString('hex') + '.jpg');
    assert.strictEqual(up.finalize.status, 200, JSON.stringify(up.finalize.data));
    if (tick !== false) assert.strictEqual((await client.patch('/images/' + up.imageId, { cleared_for_public: true })).status, 200);
    return up.imageId;
  }
  const submit = async (client, id) => assert.strictEqual((await client.post('/entries/' + id + '/submit')).status, 200);
  const publicObjects = (id) => [...s3.objects.keys()].filter((k) => k.startsWith('/public-media/public/' + id));

  describe('a. nothing public is cached', () => {
    it('Our Work, the feed, the sitemap and case pages are never cached, and taking an entry off the website takes effect on the very next request', async () => {
      const id = await entry(work, { title: 'No cache job', is_case_study: true, body: 'Para one.\n\nPara two.' });
      await photoOn(work, id); await submit(work, id);
      assert.strictEqual((await editor.patch('/entries/' + id, { is_case_study: true, body: 'Para one.\n\nPara two.' })).status, 200);
      assert.strictEqual((await editor2.post('/entries/' + id + '/approve', {})).status, 200);
      assert.strictEqual((await editor2.post('/entries/' + id + '/publish')).data.status, 'published');
      const slug = (await query('select slug from entries where id = $1', [id])).rows[0].slug;
      for (const path of ['/our-work', '/api/feed', '/sitemap-work.xml', '/our-work/' + slug, '/our-work/does-not-exist']) {
        const r = await fetch(app.origin + path);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store', path);
      }
      assert.ok((await (await fetch(app.origin + '/api/feed')).json()).items.some((i) => i.title === 'No cache job'));
      assert.strictEqual((await fetch(app.origin + '/our-work/' + slug)).status, 200);
      assert.strictEqual((await admin.post('/entries/' + id + '/unpublish')).status, 200);
      assert.ok(!(await (await fetch(app.origin + '/api/feed')).json()).items.some((i) => i.title === 'No cache job'), 'gone from the feed at once');
      assert.strictEqual((await fetch(app.origin + '/our-work/' + slug)).status, 404, 'case page gone at once');
      assert.ok(!(await (await fetch(app.origin + '/sitemap-work.xml')).text()).includes(slug), 'gone from the sitemap at once');
      assert.ok(!(await (await fetch(app.origin + '/our-work')).text()).includes('No cache job'), 'gone from Our Work at once');
    });
  });

  describe('b. independent approval', () => {
    it('an editor who changed what the entry says cannot approve it; a different editor can', async () => {
      const id = await entry(work, { title: 'Wording change job' }); await photoOn(work, id); await submit(work, id);
      assert.strictEqual((await editor.patch('/entries/' + id, { summary: 'Reworded by the office.' })).status, 200);
      const r = await editor.post('/entries/' + id + '/approve', {});
      assert.strictEqual(r.status, 403); assert.match(r.data.message, /you made the latest change/);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'pending_approval');
      assert.strictEqual((await editor2.post('/entries/' + id + '/approve', {})).status, 200);
    });
    it('writing the caption, changing the destinations, adding, removing, re-ordering or describing a photo each count as a change', async () => {
      const probes = [
        ['caption', (id) => editor.post('/entries/' + id + '/caption', { save: true })],
        ['destinations', (id) => editor.patch('/entries/' + id, { destinations: { website: true, linkedin: false }, body: 'Some body text.' })],
        ['alt text', async (id) => { const im = (await editor.get('/entries/' + id)).data.images[0]; return editor.patch('/images/' + im.id, { alt_text: 'A turned flange' }); }],
        ['reorder', async (id) => { const ims = (await editor.get('/entries/' + id)).data.images.map((i) => i.id); return editor.put('/entries/' + id + '/images/order', { order: ims.reverse() }); }],
        ['photo added', async (id) => { const up = await H.uploadImage(editor, id, await photo(), 'image/jpeg', 'extra.jpg'); return up.finalize; }],
        ['photo removed', async (id) => { const im = (await editor.get('/entries/' + id)).data.images[0]; return editor.del('/images/' + im.id); }],
      ];
      for (const [name, change] of probes) {
        const id = await entry(work, { title: 'Change probe ' + name }); await photoOn(work, id); await photoOn(work, id); await submit(work, id);
        const c = await change(id);
        assert.ok(c.status >= 200 && c.status < 300, name + ' change failed: ' + c.status + ' ' + JSON.stringify(c.data));
        if ((await editor.get('/entries/' + id)).data.entry.status === 'draft') await submit(editor, id);   // some changes send an approved copy back; here it is pending, but be safe
        const r = await editor.post('/entries/' + id + '/approve', {});
        assert.strictEqual(r.status, 403, name + ': ' + JSON.stringify(r.data));
      }
    });
    it('review work is not a content change: ticking photos as checked and editing private notes do not stop the same editor approving', async () => {
      const id = await entry(work, { title: 'Review only job' });
      await photoOn(work, id, false); await submit(work, id);
      const im = (await editor.get('/entries/' + id)).data.images[0];
      // the dashboard sends both fields every time; only the tick really changes
      assert.strictEqual((await editor.patch('/images/' + im.id, { alt_text: im.alt_text || '', cleared_for_public: true })).status, 200);
      assert.strictEqual((await editor.patch('/entries/' + id, { internal_notes: 'Office note.' })).status, 200);
      assert.strictEqual((await editor.post('/entries/' + id + '/approve', {})).status, 200);
    });
    it('taking a photo out of the public set (un-ticking it) is a content change; putting it in is review work', async () => {
      const id = await entry(work, { title: 'Untick job' }); await photoOn(work, id); await photoOn(work, id); await submit(work, id);
      const im = (await editor.get('/entries/' + id)).data.images[0];
      assert.strictEqual((await editor.patch('/images/' + im.id, { alt_text: im.alt_text || '', cleared_for_public: false })).status, 200);
      const r = await editor.post('/entries/' + id + '/approve', { excludeUncleared: true });
      assert.strictEqual(r.status, 403, JSON.stringify(r.data));
      assert.strictEqual((await editor2.post('/entries/' + id + '/approve', { excludeUncleared: true })).status, 200);
    });
    it('only the LAST editor is excluded: after another editor makes the latest change, the first editor may approve', async () => {
      const id = await entry(work, { title: 'Two editors job' }); await photoOn(work, id); await submit(work, id);
      assert.strictEqual((await editor.patch('/entries/' + id, { summary: 'First editor wording.' })).status, 200);
      assert.strictEqual((await editor2.patch('/entries/' + id, { summary: 'Second editor wording.' })).status, 200);
      assert.strictEqual((await editor2.post('/entries/' + id + '/approve', {})).status, 403);
      assert.strictEqual((await editor.post('/entries/' + id + '/approve', {})).status, 200);
    });
    it('the person who wrote the entry still cannot approve it; an editor writing their own entry needs someone else', async () => {
      const id = await entry(editor, { title: 'Editor wrote this' }); await photoOn(editor, id); await submit(editor, id);
      const r = await editor.post('/entries/' + id + '/approve', {});
      assert.strictEqual(r.status, 403); assert.match(r.data.message, /your own entry/);
      assert.strictEqual((await editor2.post('/entries/' + id + '/approve', {})).status, 200);
    });
    it('an admin can approve anything (the documented override) and it is recorded in the audit history', async () => {
      const id = await entry(work, { title: 'Admin override job' }); await photoOn(work, id); await submit(work, id);
      assert.strictEqual((await admin.patch('/entries/' + id, { summary: 'Admin reworded this.' })).status, 200);
      assert.strictEqual((await admin.post('/entries/' + id + '/approve', {})).status, 200);
      const rec = (await query("select detail from audit_log where entry_id = $1 and action = 'entry_approved'", [id])).rows[0].detail;
      assert.strictEqual(rec.independent_approval_overridden, true);
      const id2 = await entry(work, { title: 'Independent approval job' }); await photoOn(work, id2); await submit(work, id2);
      assert.strictEqual((await admin.post('/entries/' + id2 + '/approve', {})).status, 200);
      assert.strictEqual((await query("select detail from audit_log where entry_id = $1 and action = 'entry_approved'", [id2])).rows[0].detail.independent_approval_overridden, undefined, 'a normal approval is not flagged');
    });
    it('a workshop user can never approve', async () => {
      const id = await entry(work, { title: 'Workshop approve try' }); await photoOn(work, id); await submit(work, id);
      assert.strictEqual((await work.post('/entries/' + id + '/approve', {})).status, 403);
    });
  });

  describe('c. publishing and removing a photo cannot race', () => {
    async function approvedEntry(title, linkedin) {
      const id = await entry(work, { title }); const a = await photoOn(work, id); const b = await photoOn(work, id);
      if (linkedin) { assert.strictEqual((await editor.patch('/entries/' + id, { destinations: { website: true, linkedin: true } })).status, 200); assert.strictEqual((await editor.post('/entries/' + id + '/caption', { save: true })).status, 200); }
      await submit(work, id);
      assert.strictEqual((await editor2.post('/entries/' + id + '/approve', {})).status, 200);
      return { id, a, b };
    }
    it('a website publish that began before a photo was removed is refused: it can never make a page that points at deleted files', async () => {
      const { id, a, b } = await approvedEntry('Race website');
      const stale = await P.getSnapshotRow(id);                       // what publishing read
      assert.strictEqual((await editor.del('/images/' + a)).status, 200);   // the removal lands first
      await assert.rejects(P.publishWebsite({ email: 'x' }, stale), (e) => e.status === 409 && e.code === 'conflict');
      assert.strictEqual((await query('select live_snapshot from entries where id = $1', [id])).rows[0].live_snapshot, null, 'nothing went live');
      assert.ok(publicObjects(id).every((k) => !k.includes('/' + a + '-')), 'the removed photo\'s public copies were deleted: nothing points at them');
      assert.ok(publicObjects(id).every((k) => k.includes('/' + b + '-')));
    });
    it('a Buffer draft that began before a photo was removed is refused, and creates no publication', async () => {
      const { id, a } = await approvedEntry('Race linkedin', true);
      const stale = await P.getSnapshotRow(id);
      assert.strictEqual((await editor.del('/images/' + a)).status, 200);
      await assert.rejects(P.beginLinkedIn(stale, 'c'.repeat(24), 'hash'), (e) => e.status === 409);
      assert.strictEqual((await query('select count(*)::int n from publications where entry_id = $1', [id])).rows[0].n, 0);
    });
    it('a RETRY of an earlier failed Buffer attempt is protected too: the draft is never created for photos that were just deleted', async () => {
      const { id, a } = await approvedEntry('Race linkedin retry', true);
      const stale = await P.getSnapshotRow(id);
      // an earlier attempt failed before any draft existed: a failed row with no post id, last touched long ago
      const key = id + ':linkedin:' + 'c'.repeat(24) + ':hash';
      await query("insert into publications (entry_id, destination, channel_id, content_hash, idempotency_key, status, updated_at) values ($1,'linkedin',$2,'hash',$3,'failed', now() - interval '1 hour')", [id, 'c'.repeat(24), key]);
      const pub = await P.beginLinkedIn(stale, 'c'.repeat(24), 'hash');          // the retry begins (the entry is still the approved version)
      assert.strictEqual(pub.status, 'failed');
      assert.strictEqual((await editor.del('/images/' + a)).status, 200);        // the removal lands before the draft is claimed
      assert.strictEqual(publicObjects(id).length, 4, 'the retry counts as in use, so every public copy is kept');
    });
    it('a publish that wins keeps the removed photo\'s public copies for the live page', async () => {
      const { id, a } = await approvedEntry('Race publish wins');
      assert.strictEqual((await editor.post('/entries/' + id + '/publish')).data.status, 'published');
      assert.strictEqual((await editor.del('/images/' + a)).status, 200);
      const live = (await query('select live_snapshot from entries where id = $1', [id])).rows[0].live_snapshot;
      assert.ok(live.images.some((i) => i.id === a), 'the live page still lists the photo');
      assert.strictEqual(publicObjects(id).length, 4, 'and its files are still there');
    });
    it('under real concurrency (publish and remove at the same moment) a live page or Buffer draft never loses a file', async () => {
      for (let n = 0; n < 6; n++) {
        const { id, a } = await approvedEntry('Concurrent ' + n, n % 2 === 1);
        await Promise.all([editor.post('/entries/' + id + '/publish'), editor2.del('/images/' + a)]);
        const row = (await query('select live_snapshot from entries where id = $1', [id])).rows[0];
        if (row.live_snapshot) for (const i of row.live_snapshot.images) {
          for (const u of [i.url, i.thumb_url]) assert.ok(s3.objects.has('/public-media/' + new URL(u).pathname.replace(/^\//, '')), 'a live image is missing its file: ' + u);
        }
        const pubs = (await query("select status from publications where entry_id = $1 and destination = 'linkedin'", [id])).rows;
        if (pubs.length) assert.strictEqual(publicObjects(id).length, 4, 'a Buffer draft exists, so every public copy must still be there');
      }
    });
  });

  describe('LinkedIn switch for a website-only launch', () => {
    it('is on when a token is configured, and off when LINKEDIN_ENABLED=false or there is no token: the setting is refused and the page says so', async () => {
      const was = { t: process.env.BUFFER_API_TOKEN, f: process.env.LINKEDIN_ENABLED };
      try {
        assert.strictEqual((await editor.get('/auth/me')).data.features.linkedin, true);
        const id = await entry(work, { title: 'LinkedIn switch job' });
        process.env.LINKEDIN_ENABLED = 'false';
        assert.strictEqual((await editor.get('/auth/me')).data.features.linkedin, false);
        const r = await editor.patch('/entries/' + id, { destinations: { website: true, linkedin: true } });
        assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'linkedin_disabled');
        assert.strictEqual((await editor.patch('/entries/' + id, { destinations: { website: true, linkedin: false } })).status, 200, 'website-only still saves');
        delete process.env.LINKEDIN_ENABLED; delete process.env.BUFFER_API_TOKEN;
        assert.strictEqual((await editor.get('/auth/me')).data.features.linkedin, false, 'no token means off');
        assert.strictEqual((await editor.patch('/entries/' + id, { destinations: { website: true, linkedin: true } })).status, 422);
      } finally { process.env.BUFFER_API_TOKEN = was.t; if (was.f === undefined) delete process.env.LINKEDIN_ENABLED; else process.env.LINKEDIN_ENABLED = was.f; }
    });
    it('an entry approved while LinkedIn was on does not reach Buffer once it is off: the website part publishes and the confirmation says LinkedIn was not selected', async () => {
      const id = await entry(work, { title: 'Switched off later' }); await photoOn(work, id);
      assert.strictEqual((await editor.patch('/entries/' + id, { destinations: { website: true, linkedin: true } })).status, 200);
      assert.strictEqual((await editor.post('/entries/' + id + '/caption', { save: true })).status, 200);
      await submit(work, id);
      assert.strictEqual((await editor2.post('/entries/' + id + '/approve', {})).status, 200);
      const before = buf.state.calls.length;
      process.env.LINKEDIN_ENABLED = 'false';
      try {
        const r = await editor.post('/entries/' + id + '/publish');
        assert.strictEqual(r.data.status, 'published');
        assert.deepStrictEqual(r.data.results.map((x) => x.destination), ['website']);
        assert.strictEqual(buf.state.calls.length, before, 'Buffer was not contacted at all');
        assert.match(browserApi().publishSummary(r.data).text, /LinkedIn: not selected, nothing was sent to Buffer\./);
      } finally { delete process.env.LINKEDIN_ENABLED; }
    });
    it('an entry cannot be created with LinkedIn ticked while it is off', async () => {
      process.env.LINKEDIN_ENABLED = 'false';
      try {
        const r = await editor.post('/entries', base({ title: 'Created with linkedin', destinations: { website: true, linkedin: true } }), { 'idempotency-key': crypto.randomUUID() });
        assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'linkedin_disabled');
      } finally { delete process.env.LINKEDIN_ENABLED; }
    });
  });
});
