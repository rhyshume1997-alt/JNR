'use strict';
// End to end: the real API handlers and the real Postgres schema, with fake storage, fake Buffer and no internet.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const crypto = require('node:crypto');
const H = require('../testlib/harness');

const SKIP = H.BASE ? false : 'set TEST_DATABASE_URL to a Postgres server to run the database tests';
const PW = 'correct horse battery staple';

describe('workshop content system (database)', { skip: SKIP }, () => {
  let db, s3, buf, app, admin, editor, work, work2;

  before(async () => {
    db = await H.createTestDb();
    s3 = await H.startFakeS3();
    buf = await H.startFakeBuffer();
    H.setEnv(s3, buf);
    app = await H.startApp();
    const auth = require('../api/_lib/auth');
    const boss = { email: 'seed@test' };
    await auth.createUser(boss, { email: 'admin@jnr.test', name: 'Admin', role: 'admin', password: PW });
    await auth.createUser(boss, { email: 'editor@jnr.test', name: 'Editor', role: 'editor', password: PW });
    await auth.createUser(boss, { email: 'work@jnr.test', name: 'Workshop One', role: 'workshop', password: PW });
    await auth.createUser(boss, { email: 'work2@jnr.test', name: 'Workshop Two', role: 'workshop', password: PW });
    admin = app.client(); editor = app.client(); work = app.client(); work2 = app.client();
    assert.strictEqual((await admin.login('admin@jnr.test', PW)).status, 200);
    assert.strictEqual((await editor.login('editor@jnr.test', PW)).status, 200);
    assert.strictEqual((await work.login('work@jnr.test', PW)).status, 200);
    assert.strictEqual((await work2.login('work2@jnr.test', PW)).status, 200);
  });
  after(async () => { await app.close(); await s3.close(); await buf.close(); await db.drop(); });

  const base = (o) => Object.assign({ kind: 'completed', title: 'Stainless steel flange set', summary: 'Batch of flanges turned and drilled.', material: '316 stainless steel', process: 'CNC turning', stage: 'delivered' }, o || {});
  const bufCreates = () => buf.state.calls.filter((c) => /createPost/.test(c.query)).length;

  async function readyEntry(client, fields, imgCount, opts) {
    const e = await client.post('/entries', base(fields), { 'idempotency-key': crypto.randomUUID() });
    assert.strictEqual(e.status, 201, JSON.stringify(e.data));
    const id = e.data.entry.id;
    for (let i = 0; i < (imgCount === undefined ? 1 : imgCount); i++) {
      const up = await H.uploadImage(client, id, await H.jpegWithExif(1200 + i * 10, 800, '#' + (100000 + i * 1111).toString(16).padStart(6, '0')), 'image/jpeg', 'IMG_000' + i + '.jpg');
      assert.strictEqual(up.finalize.status, 200, JSON.stringify(up.finalize.data));
      if (!(opts && opts.leaveUncleared)) assert.strictEqual((await client.patch('/images/' + up.imageId, { cleared_for_public: true, alt_text: 'Finished flange ' + i })).status, 200);
    }
    return id;
  }
  async function toApproved(id, who, ack) {
    assert.strictEqual((await (who || work).post('/entries/' + id + '/submit')).status, 200);
    const r = await editor.post('/entries/' + id + '/approve', { acknowledge: ack || [] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    return r.data.entry;
  }

  describe('sign in, roles and request safety', () => {
    it('rejects wrong passwords with one generic message, then locks the account after 5 failures', async () => {
      const c = app.client();
      const unknown = await c.login('nobody@jnr.test', 'whatever whatever');
      const wrong = await c.login('work2@jnr.test', 'wrong password here');
      assert.strictEqual(unknown.status, 401); assert.strictEqual(wrong.status, 401);
      assert.strictEqual(unknown.data.message, wrong.data.message, 'must not reveal which emails exist');
      for (let i = 0; i < 4; i++) await c.login('work2@jnr.test', 'wrong password here');
      const locked = await c.login('work2@jnr.test', PW);
      assert.strictEqual(locked.status, 429);
      await require('../api/_lib/db').query("update users set locked_until = null, failed_attempts = 0 where email = 'work2@jnr.test'");
    });
    it('requires sign in, and blocks cross-site and header-less state changes', async () => {
      const anon = app.client();
      assert.strictEqual((await anon.get('/entries')).status, 401);
      const noOrigin = await fetch(app.origin + '/api/admin/entries', { method: 'POST', headers: { 'content-type': 'application/json', cookie: work.cookie, 'x-requested-with': 'jnr' }, body: JSON.stringify(base()) });
      assert.strictEqual(noOrigin.status, 403);
      const evil = await fetch(app.origin + '/api/admin/entries', { method: 'POST', headers: { 'content-type': 'application/json', cookie: work.cookie, origin: 'https://evil.example', 'x-requested-with': 'jnr' }, body: JSON.stringify(base()) });
      assert.strictEqual(evil.status, 403);
      const noHeader = await fetch(app.origin + '/api/admin/entries', { method: 'POST', headers: { 'content-type': 'application/json', cookie: work.cookie, origin: app.origin }, body: JSON.stringify(base()) });
      assert.strictEqual(noHeader.status, 403);
    });
    it('keeps workshop staff out of approval, publishing and user management; admin-only actions stay admin-only', async () => {
      const id = await readyEntry(work, {}, 0);
      assert.strictEqual((await work.post('/entries/' + id + '/approve')).status, 403);
      assert.strictEqual((await work.post('/entries/' + id + '/publish')).status, 403);
      assert.strictEqual((await work.get('/users')).status, 403);
      assert.strictEqual((await editor.get('/users')).status, 403);
      assert.strictEqual((await editor.post('/entries/' + id + '/unpublish')).status, 403);
      assert.strictEqual((await admin.get('/users')).status, 200);
    });
    it('shows workshop staff only their own entries', async () => {
      const id = await readyEntry(work, { title: 'Private to workshop one' }, 0);
      assert.strictEqual((await work2.get('/entries/' + id)).status, 404);
      assert.ok(!(await work2.get('/entries')).data.entries.some((e) => e.id === id));
      assert.ok((await work.get('/entries')).data.entries.some((e) => e.id === id));
      assert.ok((await editor.get('/entries')).data.entries.some((e) => e.id === id));
    });
    it('does not let a workshop user read internal notes or set customer-public consent', async () => {
      const r = await work.post('/entries', base({ title: 'Consent attempt', customer_name: 'Acme Ltd', internal_notes: 'secret margin', customer_public_ok: true, customer_public_label: 'Acme' }));
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.data.entry.customer_public_ok, false);
      assert.strictEqual(r.data.entry.internal_notes, undefined);
    });
  });

  describe('creating entries', () => {
    it('validates fields and explains each error', async () => {
      const r = await work.post('/entries', { kind: 'nonsense', title: 'x', summary: '' });
      assert.strictEqual(r.status, 422);
      assert.ok(r.data.errors.kind && r.data.errors.title && r.data.errors.summary);
    });
    it('is idempotent: the same key twice (a double tap or a retry on poor signal) makes one entry', async () => {
      const key = crypto.randomUUID();
      const a = await work.post('/entries', base({ title: 'Double tap' }), { 'idempotency-key': key });
      const b = await work.post('/entries', base({ title: 'Double tap' }), { 'idempotency-key': key });
      assert.strictEqual(a.status, 201); assert.strictEqual(b.status, 200);
      assert.strictEqual(a.data.entry.id, b.data.entry.id); assert.strictEqual(b.data.replayed, true);
      const n = (await require('../api/_lib/db').query("select count(*)::int n from entries where title = 'Double tap'")).rows[0].n;
      assert.strictEqual(n, 1);
    });
    it('supports in-production, completed and general updates', async () => {
      for (const kind of ['in_production', 'completed', 'update']) {
        const r = await work.post('/entries', base({ kind, title: 'Kind ' + kind, stage: kind === 'in_production' ? 'machining' : null }));
        assert.strictEqual(r.status, 201, JSON.stringify(r.data)); assert.strictEqual(r.data.entry.kind, kind);
      }
    });
  });

  describe('photo uploads', () => {
    it('sends photos straight to private storage with a signed link, keeps the original untouched, and checks it afterwards', async () => {
      const id = await readyEntry(work, { title: 'Upload check' }, 0);
      const original = await H.jpegWithExif(1600, 1000);
      const up = await H.uploadImage(work, id, original);
      assert.strictEqual(up.put.status, 200);
      assert.strictEqual(up.finalize.status, 200);
      assert.strictEqual(up.finalize.data.image.width, 1600);
      assert.ok(s3.log.some((l) => l.presigned && l.method === 'PUT'), 'upload used a signed link');
      const stored = [...s3.objects.entries()].find(([k]) => k.startsWith('/private-originals/originals/' + id));
      assert.ok(stored, 'original is in the private bucket');
      assert.ok(Buffer.compare(stored[1].body, original) === 0, 'original is stored byte for byte');
      assert.strictEqual([...s3.objects.keys()].filter((k) => k.startsWith('/public-media/')).length, 0, 'nothing public before approval');
    });
    it('refuses a signed link used with a different content type', async () => {
      const id = await readyEntry(work, { title: 'Tamper' }, 0);
      const data = await H.jpegWithExif(800, 600);
      const p = await work.post('/entries/' + id + '/images/presign', { name: 'a.jpg', type: 'image/jpeg', size: data.length });
      const put = await fetch(p.data.upload.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: data });
      assert.strictEqual(put.status, 403);
    });
    it('rejects drawings and CAD files by declared type, and by content when the type is faked', async () => {
      const id = await readyEntry(work, { title: 'Reject drawings' }, 0);
      const pdf = await work.post('/entries/' + id + '/images/presign', { name: 'drawing.pdf', type: 'application/pdf', size: H.FAKE_PDF.length });
      assert.strictEqual(pdf.status, 422); assert.strictEqual(pdf.data.error, 'not_a_photo');
      const dxf = await work.post('/entries/' + id + '/images/presign', { name: 'part.dxf', type: 'application/dxf', size: 100 });
      assert.strictEqual(dxf.status, 422);
      const faked = await H.uploadImage(work, id, H.FAKE_PDF, 'image/jpeg', 'drawing.jpg');
      assert.strictEqual(faked.finalize.status, 422); assert.strictEqual(faked.finalize.data.error, 'not_a_photo');
      const dxfFaked = await H.uploadImage(work, id, H.FAKE_DXF, 'image/png', 'part.png');
      assert.strictEqual(dxfFaked.finalize.status, 422);
      assert.ok(![...s3.objects.keys()].some((k) => k.includes(faked.imageId)), 'rejected file is deleted from storage');
      assert.strictEqual((await work.get('/entries/' + id)).data.images.length, 0, 'and no record is left');
    });
    it('rejects oversize, tiny, corrupt and duplicate photos', async () => {
      const id = await readyEntry(work, { title: 'Limits' }, 0);
      const big = await work.post('/entries/' + id + '/images/presign', { name: 'big.jpg', type: 'image/jpeg', size: 999 * 1024 * 1024 });
      assert.strictEqual(big.status, 422); assert.strictEqual(big.data.error, 'too_large');
      const tiny = await H.uploadImage(work, id, await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } }).jpeg().toBuffer());
      assert.strictEqual(tiny.finalize.data.error, 'too_small');
      const corrupt = await H.uploadImage(work, id, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('this is not really a jpeg at all, just text')]));
      assert.strictEqual(corrupt.finalize.data.error, 'corrupt_image');
      const one = await H.jpegWithExif(900, 700);
      assert.strictEqual((await H.uploadImage(work, id, one)).finalize.status, 200);
      assert.strictEqual((await H.uploadImage(work, id, one)).finalize.data.error, 'duplicate');
    });
    it('keeps uploads with the owner: another workshop user cannot upload to or preview them', async () => {
      const id = await readyEntry(work, { title: 'Not yours' }, 1);
      assert.strictEqual((await work2.post('/entries/' + id + '/images/presign', { name: 'a.jpg', type: 'image/jpeg', size: 10 })).status, 404);
      const imgs = (await work.get('/entries/' + id)).data.images;
      assert.strictEqual((await work2.get('/images/' + imgs[0].id + '/preview')).status, 404);
      const prev = await work.get('/images/' + imgs[0].id + '/preview');
      assert.strictEqual(prev.status, 200);
      const meta = await sharp(prev.data).metadata();
      assert.ok(meta.width <= 900 && !meta.exif, 'private preview is small and metadata free');
    });
    it('orders photos, and a change to an approved entry puts it back to draft', async () => {
      const id = await readyEntry(work, { title: 'Ordering' }, 3);
      const imgs = (await work.get('/entries/' + id)).data.images;
      const reversed = imgs.map((i) => i.id).reverse();
      const r = await work.put('/entries/' + id + '/images/order', { order: reversed });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.data.images.map((i) => i.id), reversed);
      assert.strictEqual((await work.put('/entries/' + id + '/images/order', { order: reversed.slice(1) })).status, 422);
      await toApproved(id);
      assert.strictEqual((await editor.put('/entries/' + id + '/images/order', { order: imgs.map((i) => i.id) })).status, 200);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'draft');
    });
  });

  describe('approval, confidentiality and public images', () => {
    it('blocks approval when the customer name, a reference or contact details are in public text', async () => {
      const id = await readyEntry(work, { title: 'Flanges for Acme Marine', summary: 'Made for Acme Marine, ref JOB-77421, call 0141 555 0100.', customer_name: 'Acme Marine', job_ref: 'JOB-77421' });
      await work.post('/entries/' + id + '/submit');
      const r = await editor.post('/entries/' + id + '/approve', {});
      assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'blocked');
      const codes = r.data.blocking.map((b) => b.code);
      assert.ok(codes.includes('customer_name') && codes.includes('job_ref') && codes.includes('phone'), codes.join());
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'pending_approval');
    });
    it('makes the approver confirm warnings about drawing numbers, tolerances and part numbers', async () => {
      const id = await readyEntry(work, { title: 'Bracket per drawing no. AB-1234 rev C', summary: 'Held to a tolerance of plus or minus 0.01.' });
      await work.post('/entries/' + id + '/submit');
      const r = await editor.post('/entries/' + id + '/approve', {});
      assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'needs_acknowledgement');
      const ack = r.data.warnings.map((w) => w.code + ':' + w.field);
      assert.ok(ack.length >= 2);
      assert.strictEqual((await editor.post('/entries/' + id + '/approve', { acknowledge: ack })).status, 200);
    });
    it('does not let the author approve their own entry, but a different approver can', async () => {
      const id = await readyEntry(editor, { title: 'Editor wrote this' }, 0);
      await editor.post('/entries/' + id + '/submit');
      assert.strictEqual((await editor.post('/entries/' + id + '/approve', {})).status, 403);
      assert.strictEqual((await admin.post('/entries/' + id + '/approve', {})).status, 200);
    });
    it('requires every photo to be marked as checked before it can go public', async () => {
      const id = await readyEntry(work, { title: 'Uncleared photo' }, 2, { leaveUncleared: true });
      await work.post('/entries/' + id + '/submit');
      const r = await editor.post('/entries/' + id + '/approve', {});
      assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'images_not_cleared');
      assert.strictEqual([...s3.objects.keys()].filter((k) => k.includes('/public/' + id)).length, 0, 'no public copy was made');
      const ok = await editor.post('/entries/' + id + '/approve', { excludeUncleared: true });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'approved');
    });
    it('creates durable public copies only at approval: resized, metadata and GPS removed, immutable names', async () => {
      const id = await readyEntry(work, { title: 'Public copies' }, 2);
      const before = [...s3.objects.keys()].filter((k) => k.includes('/public/' + id)).length;
      assert.strictEqual(before, 0);
      const entry = await toApproved(id);
      assert.strictEqual(entry.status, 'approved');
      const keys = [...s3.objects.keys()].filter((k) => k.includes('/public/' + id));
      assert.strictEqual(keys.length, 4, 'two photos, large and thumbnail each');
      for (const k of keys) {
        const o = s3.objects.get(k);
        assert.strictEqual(o.type, 'image/jpeg'); assert.match(o.cache, /immutable/);
        const meta = await sharp(o.body).metadata();
        assert.ok(!meta.exif && !meta.xmp && !meta.icc === true || !meta.exif, 'no EXIF in ' + k);
        assert.ok(!o.body.includes(Buffer.from('SECRETCAM')) && !o.body.includes(Buffer.from('SECRET-OWNER')), 'no camera or owner strings');
        assert.ok(meta.width <= 1600);
      }
      const snap = (await require('../api/_lib/db').query('select approved_snapshot s from entries where id = $1', [id])).rows[0].s;
      assert.strictEqual(snap.images.length, 2);
      snap.images.forEach((i) => assert.match(i.url, /^https:\/\/media\.example\.test\/public\/[0-9a-f-]+\/[0-9a-f-]+-[0-9a-f]{10}-1600\.jpg$/));
      assert.ok(!JSON.stringify(snap).includes('originals/'), 'snapshot never points at private originals');
    });
    it('lets the reviewer fix wording and tick photos while an entry waits for approval, without bouncing it back to draft', async () => {
      const id = await readyEntry(work, { title: 'Reviewer edits' }, 1, { leaveUncleared: true });
      await work.post('/entries/' + id + '/submit');
      const img = (await editor.get('/entries/' + id)).data.images[0];
      assert.strictEqual((await editor.patch('/images/' + img.id, { cleared_for_public: true })).status, 200);
      assert.strictEqual((await editor.patch('/entries/' + id, { summary: 'Tidied wording.' })).status, 200);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'pending_approval');
      assert.strictEqual((await editor.post('/entries/' + id + '/approve', {})).status, 200);
    });
    it('rejects a rejected entry with a reason, lets the author fix and resubmit', async () => {
      const id = await readyEntry(work, { title: 'Needs work' }, 0);
      await work.post('/entries/' + id + '/submit');
      assert.strictEqual((await editor.post('/entries/' + id + '/reject', { note: '' })).status, 422);
      const rj = await editor.post('/entries/' + id + '/reject', { note: 'Please say what material it is.' });
      assert.strictEqual(rj.data.entry.status, 'rejected');
      assert.strictEqual((await work.patch('/entries/' + id, { material: 'Mild steel' })).status, 200);
      assert.strictEqual((await work.post('/entries/' + id + '/submit')).data.entry.status, 'pending_approval');
    });
    it('only allows valid status changes', async () => {
      const id = await readyEntry(work, { title: 'Bad moves' }, 0);
      assert.strictEqual((await editor.post('/entries/' + id + '/approve', {})).status, 409, 'draft cannot be approved');
      assert.strictEqual((await editor.post('/entries/' + id + '/publish')).status, 409, 'draft cannot be published');
    });
  });

  describe('publishing: website and Buffer drafts', () => {
    let id, publishedRes;
    it('publishes an approved entry: website goes live and LinkedIn gets a verified DRAFT only', async () => {
      id = await readyEntry(work, { title: 'Flange set for the marine sector', customer_name: 'Zeta Hydraulics', job_ref: 'ZH-5521', internal_notes: 'margin is thin', customer_notes: 'phone Dave', destinations: { website: true, linkedin: true }, is_case_study: true, body: 'We turned the flanges in two set-ups.\n\nEach was checked before it left the workshop.' }, 2);
      assert.strictEqual((await editor.patch('/entries/' + id, { destinations: { website: true, linkedin: true } })).status, 200);
      const gen = await editor.post('/entries/' + id + '/caption', { save: true });
      assert.strictEqual(gen.data.source, 'template');
      await toApproved(id);
      const creates0 = bufCreates();
      publishedRes = await editor.post('/entries/' + id + '/publish');
      assert.strictEqual(publishedRes.status, 200, JSON.stringify(publishedRes.data));
      assert.strictEqual(publishedRes.data.status, 'published');
      assert.deepStrictEqual(publishedRes.data.results.map((r) => r.status), ['verified', 'verified']);
      assert.strictEqual(bufCreates() - creates0, 1);
      const call = buf.state.calls.filter((c) => /createPost/.test(c.query)).pop();
      assert.strictEqual(call.variables.input.saveToDraft, true);
      assert.strictEqual(call.variables.input.dueAt, undefined);
      assert.strictEqual(call.variables.input.channelId, 'a'.repeat(24), 'staging uses the staging channel only');
      assert.strictEqual(call.auth, 'Bearer good-token');
      assert.strictEqual(call.variables.input.assets.length, 2);
      assert.ok(call.variables.input.assets.every((a) => a.image.url.startsWith('https://media.example.test/public/')), 'public URLs, never private');
      const post = [...buf.state.posts.values()].pop();
      assert.strictEqual(post.status, 'draft');
      assert.ok(buf.state.calls.some((c) => /ReadPost/.test(c.query)), 'it read the draft back');
    });
    it('records a verified publication per destination', async () => {
      const pubs = (await editor.get('/entries/' + id)).data.publications;
      assert.deepStrictEqual(pubs.map((p) => p.status).sort(), ['verified', 'verified']);
      assert.ok(pubs.find((p) => p.destination === 'linkedin').buffer_post_id);
    });
    it('shows the entry on Our Work, the feed and a case study page, without any private data', async () => {
      const list = await fetch(app.origin + '/our-work'); const html = await list.text();
      assert.strictEqual(list.status, 200);
      assert.match(html, /Flange set for the marine sector/);
      assert.match(list.headers.get('cache-control'), /s-maxage/);
      assert.ok(!/noindex/.test(html), 'indexable once there is real content');
      const feed = await (await fetch(app.origin + '/api/feed')).json();
      assert.strictEqual(feed.items[0].title, 'Flange set for the marine sector');
      const slug = (await require('../api/_lib/db').query('select slug from entries where id = $1', [id])).rows[0].slug;
      const cs = await fetch(app.origin + '/our-work/' + slug); const csHtml = await cs.text();
      assert.strictEqual(cs.status, 200);
      assert.match(csHtml, /two set-ups/);
      for (const secret of ['Zeta Hydraulics', 'ZH-5521', 'margin is thin', 'phone Dave', 'originals/', 'private-originals']) {
        assert.ok(!html.includes(secret) && !csHtml.includes(secret) && !JSON.stringify(feed).includes(secret), 'leaked: ' + secret);
      }
    });
    it('does not send a second draft when the same content is published again (idempotent)', async () => {
      assert.strictEqual((await admin.post('/entries/' + id + '/unpublish')).data.entry.status, 'approved');
      assert.strictEqual((await fetch(app.origin + '/api/feed').then((r) => r.json())).items.length, 0);
      const creates = bufCreates();
      const again = await editor.post('/entries/' + id + '/publish');
      assert.strictEqual(again.data.status, 'published');
      assert.strictEqual(bufCreates(), creates, 'no new Buffer post');
      assert.strictEqual(again.data.results.find((r) => r.destination === 'linkedin').unchanged, true);
    });
    it('keeps showing the last approved version until an edit is approved again', async () => {
      assert.strictEqual((await editor.patch('/entries/' + id, { title: 'Edited title, not approved yet' })).status, 200);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'draft');
      assert.match(await (await fetch(app.origin + '/our-work')).text(), /Flange set for the marine sector/);
      assert.ok(!(await (await fetch(app.origin + '/our-work')).text()).includes('Edited title'));
      await editor.post('/entries/' + id + '/submit');
      assert.strictEqual((await admin.post('/entries/' + id + '/approve', {})).status, 200);
      assert.ok(!(await (await fetch(app.origin + '/our-work')).text()).includes('Edited title'), 'approved but not published: still old');
      const creates = bufCreates();
      assert.strictEqual((await editor.post('/entries/' + id + '/publish')).data.status, 'published');
      assert.match(await (await fetch(app.origin + '/our-work')).text(), /Edited title, not approved yet/);
      assert.strictEqual(bufCreates() - creates, 0, 'caption and photos unchanged, so no second draft');
    });
    it('returns 404 for entries that are not live, and for odd slugs', async () => {
      assert.strictEqual((await fetch(app.origin + '/our-work/does-not-exist')).status, 404);
      assert.strictEqual((await fetch(app.origin + '/our-work/..%2F..%2Fetc')).status, 404);
    });
  });

  describe('Buffer failures', () => {
    async function approvedForLinkedIn(title) {
      const id = await readyEntry(work, { title, destinations: { website: false, linkedin: true } }, 1);
      await editor.patch('/entries/' + id, { destinations: { website: false, linkedin: true } });
      await editor.post('/entries/' + id + '/caption', { save: true });
      await toApproved(id);
      return id;
    }
    it('retries a rate limit and then saves the draft once', async () => {
      const id = await approvedForLinkedIn('Rate limited');
      buf.state.mode = '429'; buf.state.failures = 2;
      const creates = bufCreates();
      const r = await editor.post('/entries/' + id + '/publish');
      buf.state.mode = 'ok';
      assert.strictEqual(r.data.status, 'published');
      assert.strictEqual(bufCreates() - creates, 3, 'two refused, one accepted');
      assert.strictEqual([...buf.state.posts.values()].filter((p) => p.text.includes('Rate limited')).length, 1);
    });
    it('marks a refused request as failed (not uncertain), keeps the entry retryable, and succeeds on retry', async () => {
      const id = await approvedForLinkedIn('Refused then fine');
      buf.state.mode = 'mutation-error'; buf.state.failures = 1;
      const r = await editor.post('/entries/' + id + '/publish');
      buf.state.mode = 'ok';
      assert.strictEqual(r.data.status, 'failed'); assert.match(r.data.results[0].error, /disconnected/);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'failed');
      const retry = await editor.post('/entries/' + id + '/publish');
      assert.strictEqual(retry.data.status, 'published');
    });
    it('does not retry a request that may already have been processed: it becomes uncertain, with no duplicate', async () => {
      const id = await approvedForLinkedIn('Lost reply');
      buf.state.mode = '503-after'; buf.state.failures = 1;
      const creates = bufCreates();
      const r = await editor.post('/entries/' + id + '/publish');
      buf.state.mode = 'ok';
      assert.strictEqual(r.data.status, 'failed'); assert.strictEqual(r.data.results[0].status, 'uncertain');
      assert.strictEqual(bufCreates() - creates, 1, 'sent exactly once');
      const again = await editor.post('/entries/' + id + '/publish');
      assert.strictEqual(again.data.results[0].status, 'uncertain');
      assert.strictEqual(bufCreates() - creates, 1, 'still not re-sent');
      const pub = (await editor.get('/entries/' + id)).data.publications.find((p) => p.destination === 'linkedin');
      const found = [...buf.state.posts.values()].find((p) => p.text.includes('Lost reply'));
      assert.ok(found, 'the draft really was created behind the lost reply');
      assert.strictEqual((await editor.post('/publications/' + pub.id + '/resolve', { action: 'link', buffer_post_id: 'nothex' })).status, 422);
      assert.strictEqual((await editor.post('/publications/' + pub.id + '/resolve', { action: 'link', buffer_post_id: found.id })).status, 200);
      const done = await editor.post('/entries/' + id + '/publish');
      assert.strictEqual(done.data.status, 'published');
      assert.strictEqual(bufCreates() - creates, 1, 'linked the existing draft instead of creating another');
    });
    it('treats a dropped connection after sending as uncertain too, and lets an operator confirm "no draft" to retry', async () => {
      const id = await approvedForLinkedIn('Connection reset');
      buf.state.mode = 'reset-after'; buf.state.failures = 1;
      const r = await editor.post('/entries/' + id + '/publish');
      buf.state.mode = 'ok';
      assert.strictEqual(r.data.results[0].status, 'uncertain');
      const pub = (await editor.get('/entries/' + id)).data.publications.find((p) => p.destination === 'linkedin');
      buf.state.posts.forEach((p, k) => { if (p.text.includes('Connection reset')) buf.state.posts.delete(k); });
      assert.strictEqual((await editor.post('/publications/' + pub.id + '/resolve', { action: 'retry' })).status, 200);
      assert.strictEqual((await editor.post('/entries/' + id + '/publish')).data.status, 'published');
    });
    it('fails the check when Buffer stored something different, and can discard and recreate', async () => {
      const id = await approvedForLinkedIn('Mismatch');
      buf.state.mutate = (p) => { p.text = p.text + ' (edited by something else)'; };
      const r = await editor.post('/entries/' + id + '/publish');
      buf.state.mutate = null;
      assert.strictEqual(r.data.status, 'failed'); assert.match(r.data.results[0].error, /caption differs/);
      const pub = (await editor.get('/entries/' + id)).data.publications.find((p) => p.destination === 'linkedin');
      assert.strictEqual((await editor.post('/publications/' + pub.id + '/resolve', { action: 'discard' })).status, 200);
      assert.strictEqual((await editor.post('/entries/' + id + '/publish')).data.status, 'published');
    });
    it('fails clearly when the connection is refused, without marking the post uncertain', async () => {
      const id = await approvedForLinkedIn('Unreachable');
      const probe = require('node:net').createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
      const closedPort = probe.address().port; await new Promise((r) => probe.close(r));
      const real = process.env.BUFFER_API_URL; process.env.BUFFER_API_URL = 'http://127.0.0.1:' + closedPort;
      const r = await editor.post('/entries/' + id + '/publish');
      process.env.BUFFER_API_URL = real;
      assert.strictEqual(r.data.results[0].status, 'failed'); assert.match(r.data.results[0].error, /Could not reach Buffer/);
      assert.strictEqual((await editor.post('/entries/' + id + '/publish')).data.status, 'published');
    });
    it('reports a bad token without leaking it', async () => {
      const id = await approvedForLinkedIn('Bad token');
      process.env.BUFFER_API_TOKEN = 'wrong-token-value';
      const r = await editor.post('/entries/' + id + '/publish');
      process.env.BUFFER_API_TOKEN = 'good-token';
      assert.strictEqual(r.data.results[0].status, 'failed');
      assert.ok(!JSON.stringify(r.data).includes('wrong-token-value'));
    });
    it('uses only the staging channel in staging, and refuses production without a configured channel', async () => {
      const id = await approvedForLinkedIn('Channel rules');
      process.env.BUFFER_ENV = 'production'; delete process.env.BUFFER_CHANNEL_ID_LINKEDIN;
      const r = await editor.post('/entries/' + id + '/publish');
      assert.match(r.data.results[0].error, /BUFFER_CHANNEL_ID_LINKEDIN is not set/);
      process.env.BUFFER_CHANNEL_ID_LINKEDIN = 'c'.repeat(24);
      const calls0 = buf.state.calls.length;
      assert.strictEqual((await editor.post('/entries/' + id + '/publish')).data.status, 'published');
      assert.strictEqual(buf.state.calls.filter((c, i) => i >= calls0 && /createPost/.test(c.query))[0].variables.input.channelId, 'c'.repeat(24));
      process.env.BUFFER_ENV = 'staging'; process.env.BUFFER_CHANNEL_ID_LINKEDIN = 'b'.repeat(24);
    });
  });

  describe('audit history', () => {
    it('records who did what, and keeps private values out of it', async () => {
      const id = await readyEntry(work, { title: 'Audited job', customer_name: 'Hidden Customer Ltd', internal_notes: 'keep this private' }, 1);
      await editor.patch('/entries/' + id, { customer_name: 'Hidden Customer Ltd 2', summary: 'Updated summary text.' });
      await toApproved(id);
      const a = (await editor.get('/entries/' + id + '/audit')).data.audit;
      const actions = a.map((x) => x.action);
      for (const want of ['entry_created', 'image_added', 'entry_updated', 'entry_submitted', 'entry_approved']) assert.ok(actions.includes(want), 'missing ' + want + ' in ' + actions.join());
      assert.ok(a.some((x) => x.actor_email === 'editor@jnr.test' && x.action === 'entry_approved'));
      const dump = JSON.stringify(a);
      assert.ok(!dump.includes('Hidden Customer') && !dump.includes('keep this private'), 'private values are recorded by field name only');
      assert.ok((await require('../api/_lib/db').query("select count(*)::int n from audit_log where action in ('login','login_failed')")).rows[0].n > 0, 'sign-ins are audited');
    });
  });
});
