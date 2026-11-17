'use strict';
// Regression tests for the five defects found on the protected preview (17 Nov):
//   1. the "Published" banner said LinkedIn had a draft even when LinkedIn was not selected
//   2. failed photo uploads left unfinished rows that blocked sending and used up the photo limit
//   3. image sizes in the page and the feed did not match the generated picture (portrait photos)
//   4. removing a photo left its private original (and unused public copies) in storage, or removed copies still in use
//   5. the staging end-to-end script left the small public copies behind
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const H = require('../testlib/harness');

const SKIP = H.BASE ? false : 'set TEST_DATABASE_URL to a Postgres server to run the database tests';
const PW = 'correct horse battery staple';
const ROOT = path.join(__dirname, '..');

function loadBrowserApi() {
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'assets/api.js'), 'utf8'), { window: win, document: {}, console, setTimeout, XMLHttpRequest: function () {} });
  return win.JNR;
}

describe('1. publish banner (browser logic, no database)', () => {
  const J = loadBrowserApi();
  it('website only: says published, says LinkedIn was not selected and nothing went to Buffer, and never claims a draft', () => {
    const r = J.publishSummary({ status: 'published', results: [{ destination: 'website', status: 'verified' }] });
    assert.strictEqual(r.kind, 'ok');
    assert.match(r.text, /Website: published\./);
    assert.match(r.text, /LinkedIn: not selected, nothing was sent to Buffer\./);
    assert.ok(!/draft saved/i.test(r.text), r.text);
  });
  it('both verified: reports the Buffer draft as checked and that nothing was posted', () => {
    const r = J.publishSummary({ status: 'published', results: [{ destination: 'website', status: 'verified' }, { destination: 'linkedin', status: 'verified' }] });
    assert.strictEqual(r.kind, 'ok');
    assert.match(r.text, /LinkedIn: draft saved in Buffer and checked\. Nothing was posted\./);
  });
  it('LinkedIn only: does not claim the website was published', () => {
    const r = J.publishSummary({ status: 'published', results: [{ destination: 'linkedin', status: 'verified' }] });
    assert.match(r.text, /Website: not selected\./);
    assert.ok(!/Website: published/.test(r.text));
  });
  it('a Buffer failure is a warning that says what failed, and the website result is still reported separately', () => {
    const r = J.publishSummary({ status: 'failed', results: [{ destination: 'website', status: 'verified' }, { destination: 'linkedin', status: 'failed', error: 'Buffer said no' }] });
    assert.strictEqual(r.kind, 'warn');
    assert.match(r.text, /^Not everything finished\./);
    assert.match(r.text, /Website: published\./);
    assert.match(r.text, /LinkedIn: did not finish \(Buffer said no\)\./);
    assert.ok(!/Published\. /.test(r.text));
  });
  it('saved-but-unchecked and uncertain are never reported as verified', () => {
    const saved = J.publishSummary({ status: 'failed', results: [{ destination: 'linkedin', status: 'saved' }] });
    assert.match(saved.text, /could not be checked yet/); assert.strictEqual(saved.kind, 'warn');
    const unsure = J.publishSummary({ status: 'failed', results: [{ destination: 'linkedin', status: 'uncertain' }] });
    assert.match(unsure.text, /not sure whether the draft reached Buffer/); assert.strictEqual(unsure.kind, 'warn');
  });
});

describe('2b. the form removes a failed upload, but never a photo that may have been accepted (browser logic, no database)', () => {
  // Runs assets/api.js with a scripted server and a storage upload that always succeeds.
  function scenario(finalizeReply) {
    const calls = [];
    const win = {};
    const XHR = function () { this.upload = {}; };
    XHR.prototype.open = function () {}; XHR.prototype.setRequestHeader = function () {};
    XHR.prototype.send = function () { this.status = 200; setImmediate(() => this.onload()); };
    const fetchFake = async (url, opts) => {
      calls.push(opts.method + ' ' + url.replace('/api/admin', ''));
      if (/presign$/.test(url)) return { ok: true, status: 201, json: async () => ({ image_id: 'img-1', upload: { url: 'https://r2.example/x', method: 'PUT', headers: {} } }) };
      if (/finalize$/.test(url)) return finalizeReply();
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'assets/api.js'), 'utf8'), { window: win, document: {}, console, setTimeout: (f) => setImmediate(f), fetch: fetchFake, XMLHttpRequest: XHR });
    return { J: win.JNR, calls };
  }
  const file = { name: 'a.jpg', type: 'image/jpeg', size: 10 };
  it('when the server says the upload did not arrive, the unfinished upload is removed', async () => {
    const s = scenario(async () => ({ ok: false, status: 409, json: async () => ({ message: 'The upload did not arrive.' }) }));
    await assert.rejects(s.J.uploadPhoto('e1', file), /did not arrive/);
    assert.ok(s.calls.includes('DELETE /images/img-1'), s.calls.join(' | '));
  });
  it('a gateway error from "finalize" may hide an accepted photo, so it is NOT removed either', async () => {
    const s = scenario(async () => ({ ok: false, status: 504, json: async () => ({}) }));
    await assert.rejects(s.J.uploadPhoto('e1', file));
    assert.ok(!s.calls.some((c) => c.startsWith('DELETE')), s.calls.join(' | '));
  });
  it('when there is no reply at all to "finalize", the photo may have been accepted and is NOT removed', async () => {
    const s = scenario(async () => { throw new TypeError('network down'); });
    await assert.rejects(s.J.uploadPhoto('e1', file), /No connection/);
    assert.ok(!s.calls.some((c) => c.startsWith('DELETE')), s.calls.join(' | '));
  });
});

describe('3. image sizes (no database)', () => {
  const { thumbSize } = require('../api/_lib/render');
  it('portrait, landscape and small pictures get the size the small copy really has (long side at most 640, never enlarged)', () => {
    assert.deepStrictEqual(thumbSize({ width: 1067, height: 1600 }), { width: 427, height: 640 });
    assert.deepStrictEqual(thumbSize({ width: 1600, height: 1067 }), { width: 640, height: 427 });
    assert.deepStrictEqual(thumbSize({ width: 500, height: 300 }), { width: 500, height: 300 });
  });
  it('uses the stored size when the snapshot has it', () => {
    assert.deepStrictEqual(thumbSize({ width: 1600, height: 1067, thumb_width: 640, thumb_height: 426 }), { width: 640, height: 426 });
  });
});

describe('preview findings (database)', { skip: SKIP }, () => {
  let db, s3, buf, app, editor, approver, work, E;
  before(async () => {
    db = await H.createTestDb(); s3 = await H.startFakeS3(); buf = await H.startFakeBuffer(); H.setEnv(s3, buf);
    app = await H.startApp();
    E = require('../api/_lib/entries');
    const auth = require('../api/_lib/auth');
    const boss = { email: 'seed@test' };
    await auth.createUser(boss, { email: 'editor@jnr.test', name: 'Editor', role: 'editor', password: PW });
    await auth.createUser(boss, { email: 'approver@jnr.test', name: 'Second Editor', role: 'editor', password: PW });
    await auth.createUser(boss, { email: 'work@jnr.test', name: 'Workshop One', role: 'workshop', password: PW });
    editor = app.client(); approver = app.client(); work = app.client();
    assert.strictEqual((await approver.login('approver@jnr.test', PW)).status, 200);
    assert.strictEqual((await editor.login('editor@jnr.test', PW)).status, 200);
    assert.strictEqual((await work.login('work@jnr.test', PW)).status, 200);
  });
  after(async () => { await app.close(); await s3.close(); await buf.close(); await db.drop(); });

  const { query } = require('../api/_lib/db');
  const base = (o) => Object.assign({ kind: 'completed', title: 'Stainless steel flange set', summary: 'Batch of flanges turned and drilled.', material: '316 stainless steel', process: 'CNC turning', stage: 'delivered', destinations: { website: true, linkedin: false } }, o || {});
  const objects = (prefix) => [...s3.objects.keys()].filter((k) => k.startsWith(prefix));
  const privateOf = (id) => objects('/private-originals/originals/' + id);
  const publicOf = (id) => objects('/public-media/public/' + id);
  let colour = 0x200000;
  const photo = (w, h) => H.jpegWithExif(w || 1200, h || 800, '#' + (colour += 0x1111).toString(16).padStart(6, '0'));
  const bufCreates = () => buf.state.calls.filter((c) => /createPost/.test(c.query)).length;

  async function newEntry(client, fields) {
    const e = await client.post('/entries', base(fields), { 'idempotency-key': crypto.randomUUID() });
    assert.strictEqual(e.status, 201, JSON.stringify(e.data));
    return e.data.entry.id;
  }
  async function addPhoto(client, id, w, h, name) {
    const up = await H.uploadImage(client, id, await photo(w, h), 'image/jpeg', name || ('IMG_' + crypto.randomBytes(3).toString('hex') + '.jpg'));
    assert.strictEqual(up.finalize.status, 200, JSON.stringify(up.finalize.data));
    assert.strictEqual((await client.patch('/images/' + up.imageId, { cleared_for_public: true, alt_text: 'Photo' })).status, 200);
    return up.imageId;
  }
  async function approved(id) {
    assert.strictEqual((await work.post('/entries/' + id + '/submit')).status, 200);
    const r = await approver.post('/entries/' + id + '/approve', { acknowledge: [] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  }
  async function published(id) {
    await approved(id);
    const r = await editor.post('/entries/' + id + '/publish');
    assert.strictEqual(r.data.status, 'published', JSON.stringify(r.data));
    return r.data;
  }
  const rows = async (id) => (await query('select id, state, position from entry_images where entry_id = $1 order by position', [id])).rows;
  const withLimit = async (n, fn) => { const was = process.env.UPLOAD_MAX_PER_ENTRY; process.env.UPLOAD_MAX_PER_ENTRY = String(n); try { await fn(); } finally { if (was === undefined) delete process.env.UPLOAD_MAX_PER_ENTRY; else process.env.UPLOAD_MAX_PER_ENTRY = was; } };
  const presign = (client, id, name, size) => client.post('/entries/' + id + '/images/presign', { name, type: 'image/jpeg', size: size || 1000 });

  describe('1. publishing reports only what really happened', () => {
    it('website only: the server returns only the website result and creates no Buffer draft, so the banner cannot mention LinkedIn', async () => {
      const id = await newEntry(work, { title: 'Website only job' });
      await addPhoto(work, id);
      const before = bufCreates();
      const r = await published(id);
      assert.deepStrictEqual(r.results.map((x) => x.destination), ['website']);
      assert.strictEqual(bufCreates() - before, 0, 'no Buffer draft was created');
      const text = loadBrowserApi().publishSummary(r).text;
      assert.match(text, /LinkedIn: not selected, nothing was sent to Buffer\./);
      assert.ok(!/draft saved/i.test(text));
    });
    it('website and LinkedIn: both results come back and the banner reports the verified draft', async () => {
      const id = await newEntry(work, { title: 'Both destinations job' });
      await addPhoto(work, id);
      assert.strictEqual((await editor.patch('/entries/' + id, { destinations: { website: true, linkedin: true } })).status, 200);
      assert.strictEqual((await editor.post('/entries/' + id + '/caption', { save: true })).status, 200);
      const before = bufCreates();
      const r = await published(id);
      assert.deepStrictEqual(r.results.map((x) => x.destination).sort(), ['linkedin', 'website']);
      assert.strictEqual(bufCreates() - before, 1);
      assert.match(loadBrowserApi().publishSummary(r).text, /LinkedIn: draft saved in Buffer and checked\. Nothing was posted\./);
    });
    it('a Buffer failure is reported as not finished, never as published', async () => {
      const id = await newEntry(work, { title: 'Buffer fails job' });
      await addPhoto(work, id);
      assert.strictEqual((await editor.patch('/entries/' + id, { destinations: { website: true, linkedin: true } })).status, 200);
      assert.strictEqual((await editor.post('/entries/' + id + '/caption', { save: true })).status, 200);
      await approved(id);
      buf.state.mode = 'mutation-error'; buf.state.failures = 99;
      try {
        const r = await editor.post('/entries/' + id + '/publish');
        assert.strictEqual(r.data.status, 'failed');
        const s = loadBrowserApi().publishSummary(r.data);
        assert.strictEqual(s.kind, 'warn'); assert.match(s.text, /^Not everything finished\./); assert.match(s.text, /LinkedIn: did not finish/);
      } finally { buf.state.mode = 'ok'; buf.state.failures = 0; }
    });
  });

  describe('2. unfinished uploads', () => {
    it('a failed upload that the browser removes leaves no row, no object, and does not stop the entry being sent', async () => {
      const id = await newEntry(work, { title: 'Failed upload job' });
      await addPhoto(work, id);
      const p = await presign(work, id, 'lost-signal.jpg');           // link issued, file never arrived
      assert.strictEqual(p.status, 201);
      assert.strictEqual((await work.post('/images/' + p.data.image_id + '/finalize')).status, 409);   // "upload did not arrive"
      assert.strictEqual((await work.get('/entries/' + id)).data.images.length, 1, 'only finished photos are listed');
      assert.strictEqual((await work.post('/entries/' + id + '/submit')).status, 409, 'a fresh unfinished upload still holds the entry back');
      assert.strictEqual((await work.del('/images/' + p.data.image_id)).status, 200);   // what the form does when it gives up
      assert.deepStrictEqual((await rows(id)).map((r) => r.state), ['ready']);
      assert.strictEqual((await work.post('/entries/' + id + '/submit')).status, 200);
    });
    it('retrying the same file reuses its unfinished upload instead of adding rows', async () => {
      const id = await newEntry(work, { title: 'Retry job' });
      const a = await presign(work, id, 'same.jpg', 5555); const b = await presign(work, id, 'same.jpg', 5555); const c = await presign(work, id, 'same.jpg', 5555);
      assert.strictEqual(a.data.image_id, b.data.image_id); assert.strictEqual(b.data.image_id, c.data.image_id);
      assert.strictEqual((await rows(id)).length, 1);
      const other = await presign(work, id, 'different.jpg', 5555);
      assert.notStrictEqual(other.data.image_id, a.data.image_id);
      assert.strictEqual((await rows(id)).length, 2);
    });
    it('a retried upload still completes normally on the reused row', async () => {
      const id = await newEntry(work, { title: 'Retry completes' });
      const data = await photo(1300, 900);
      const first = await presign(work, id, 'retry.jpg', data.length);
      const second = await presign(work, id, 'retry.jpg', data.length);
      assert.strictEqual(first.data.image_id, second.data.image_id);
      assert.strictEqual((await fetch(second.data.upload.url, { method: 'PUT', headers: second.data.upload.headers, body: data })).status, 200);
      assert.strictEqual((await work.post('/images/' + second.data.image_id + '/finalize')).status, 200);
      assert.strictEqual((await rows(id)).length, 1);
    });
    it('unfinished uploads never use up the photo limit; the limit counts finished photos only, and unfinished ones have their own bound', async () => {
      await withLimit(3, async () => {
        const id = await newEntry(work, { title: 'Limit job' });
        await presign(work, id, 'gone-1.jpg', 111); await presign(work, id, 'gone-2.jpg', 222);   // two abandoned, never removed
        for (let i = 0; i < 3; i++) await addPhoto(work, id);                                     // three real photos still fit
        const fourth = await H.uploadImage(work, id, await photo(), 'image/jpeg', 'fourth.jpg');
        assert.strictEqual(fourth.presign.status, 422); assert.strictEqual(fourth.presign.data.error, 'too_many');
        const id2 = await newEntry(work, { title: 'Pending bound job' });
        for (let i = 0; i < 3; i++) assert.strictEqual((await presign(work, id2, 'u' + i + '.jpg', 100 + i)).status, 201);
        const over = await presign(work, id2, 'u-extra.jpg', 999);
        assert.strictEqual(over.status, 429); assert.strictEqual(over.data.error, 'too_many_pending');
      });
    });
    it('an upload whose link has expired is cleared, with its stored object, the next time the entry is used', async () => {
      const id = await newEntry(work, { title: 'Expired upload job' });
      await addPhoto(work, id);
      const data = await photo();
      const p = await presign(work, id, 'half.jpg', data.length);
      assert.strictEqual((await fetch(p.data.upload.url, { method: 'PUT', headers: p.data.upload.headers, body: data })).status, 200);   // arrived, never finalized
      assert.strictEqual(privateOf(id).length, 2);
      await query("update entry_images set created_at = now() - interval '20 minutes' where id = $1", [p.data.image_id]);
      assert.strictEqual((await work.post('/entries/' + id + '/submit')).status, 200, 'the abandoned upload no longer blocks sending');
      assert.deepStrictEqual((await rows(id)).map((r) => r.state), ['ready']);
      assert.strictEqual(privateOf(id).length, 1, 'its stored object is gone too');
    });
    it('an abandoned upload whose object cannot be deleted is recorded for the next cleanup, not forgotten', async () => {
      const { storage } = require('../api/_lib/s3');
      const id = await newEntry(work, { title: 'Stubborn upload job' });
      const data = await photo();
      const p = await presign(work, id, 'stubborn.jpg', data.length);
      assert.strictEqual((await fetch(p.data.upload.url, { method: 'PUT', headers: p.data.upload.headers, body: data })).status, 200);
      await query("update entry_images set created_at = now() - interval '20 minutes' where id = $1", [p.data.image_id]);
      const realDel = storage.del; storage.del = async () => { throw new Error('storage unavailable'); };
      const quiet = console.error; console.error = () => {};
      try { assert.strictEqual(await E.purgeAbandonedUploads(id), 1); } finally { storage.del = realDel; console.error = quiet; }
      assert.strictEqual((await rows(id)).length, 0, 'the row no longer blocks anything');
      assert.strictEqual(privateOf(id).length, 1, 'the object is still there');
      const rec = (await query("select detail from audit_log where entry_id = $1 and action = 'storage_delete_failed'", [id])).rows;
      assert.deepStrictEqual(rec[0].detail.keys, ['private:originals/' + id + '/' + p.data.image_id]);
    });
    it('a slow upload that finishes just as the purge runs is never deleted (the row is claimed first)', async () => {
      const id = await newEntry(work, { title: 'Race job' });
      const data = await photo();
      const p = await presign(work, id, 'slow.jpg', data.length);
      assert.strictEqual((await fetch(p.data.upload.url, { method: 'PUT', headers: p.data.upload.headers, body: data })).status, 200);
      assert.strictEqual((await work.post('/images/' + p.data.image_id + '/finalize')).status, 200);   // finished...
      await query("update entry_images set created_at = now() - interval '20 minutes' where id = $1", [p.data.image_id]);   // ...though it looks old
      assert.strictEqual(await E.purgeAbandonedUploads(id), 0);
      assert.strictEqual(privateOf(id).length, 1, 'the photo\'s original is untouched');
      assert.deepStrictEqual((await rows(id)).map((r) => r.state), ['ready']);
    });
    it('the photo limit still holds when several uploads finish together: the extra one is refused and removed', async () => {
      await withLimit(3, async () => {
        const id = await newEntry(work, { title: 'Finish together job' });
        await addPhoto(work, id); await addPhoto(work, id);
        const files = [await photo(), await photo()];
        const links = [await presign(work, id, 'a.jpg', files[0].length), await presign(work, id, 'b.jpg', files[1].length)];
        for (let i = 0; i < 2; i++) assert.strictEqual((await fetch(links[i].data.upload.url, { method: 'PUT', headers: links[i].data.upload.headers, body: files[i] })).status, 200);
        const done = await Promise.all(links.map((l) => work.post('/images/' + l.data.image_id + '/finalize')));
        assert.deepStrictEqual(done.map((d) => d.status).sort(), [200, 422]);
        assert.strictEqual(done.find((d) => d.status === 422).data.error, 'too_many');
        assert.strictEqual((await rows(id)).filter((r) => r.state === 'ready').length, 3);
        assert.strictEqual((await rows(id)).length, 3, 'the refused one left no row');
        assert.strictEqual(privateOf(id).length, 3, 'and no stored object');
      });
    });
    it('finishing the same upload twice at once (a client retry) keeps the photo, even when it is the last one that fits', async () => {
      await withLimit(3, async () => {
        const id = await newEntry(work, { title: 'Double finish job' });
        await addPhoto(work, id); await addPhoto(work, id);
        const data = await photo();
        const p = await presign(work, id, 'last.jpg', data.length);
        assert.strictEqual((await fetch(p.data.upload.url, { method: 'PUT', headers: p.data.upload.headers, body: data })).status, 200);
        const done = await Promise.all([work.post('/images/' + p.data.image_id + '/finalize'), work.post('/images/' + p.data.image_id + '/finalize')]);
        assert.deepStrictEqual(done.map((d) => d.status), [200, 200]);
        assert.strictEqual((await rows(id)).filter((r) => r.state === 'ready').length, 3);
        assert.strictEqual(privateOf(id).length, 3, 'the photo\'s original is still stored');
      });
    });
    it('sending someone else\'s entry is refused before anything is cleaned up on it', async () => {
      const auth = require('../api/_lib/auth');
      await auth.createUser({ email: 'seed@test' }, { email: 'work4@jnr.test', name: 'Workshop Four', role: 'workshop', password: PW });
      const other = app.client(); assert.strictEqual((await other.login('work4@jnr.test', PW)).status, 200);
      const id = await newEntry(work, { title: 'Hands off job' });
      const p = await presign(work, id, 'old.jpg', 5);
      await query("update entry_images set created_at = now() - interval '20 minutes' where id = $1", [p.data.image_id]);
      const r = await other.post('/entries/' + id + '/submit');
      assert.ok(r.status === 403 || r.status === 404, 'refused, got ' + r.status);
      assert.strictEqual((await rows(id)).length, 1, 'their unfinished upload was not touched');
    });
    it('removing an unfinished upload on an approved entry does not send the entry back to draft', async () => {
      const id = await newEntry(work, { title: 'Approved stays approved' });
      await addPhoto(work, id);
      await approved(id);
      const p = await presign(editor, id, 'extra.jpg', 321);
      assert.strictEqual(p.status, 201);
      assert.strictEqual((await editor.del('/images/' + p.data.image_id)).status, 200);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'approved');
    });
    it('photos can be re-ordered while an upload is unfinished, and new photos go to the end', async () => {
      const id = await newEntry(work, { title: 'Order job' });
      const a = await addPhoto(work, id); const b = await addPhoto(work, id);
      await presign(work, id, 'pending.jpg', 444);
      const o = await work.put('/entries/' + id + '/images/order', { order: [b, a] });
      assert.strictEqual(o.status, 200, JSON.stringify(o.data));
      assert.deepStrictEqual(o.data.images ? o.data.images.map((i) => i.id) : (o.data.map ? o.data.map((i) => i.id) : []), [b, a]);
      const c = await addPhoto(work, id);
      assert.deepStrictEqual((await work.get('/entries/' + id)).data.images.map((i) => i.id), [b, a, c]);
    });
  });

  describe('3. sizes match the generated pictures', () => {
    it('portrait and landscape photos: the feed and the page carry the real size of the small copy', async () => {
      const id = await newEntry(work, { title: 'Tall photo first job' });
      await addPhoto(work, id, 1200, 1800);   // portrait first, so it is the picture on the list page and in the feed
      await addPhoto(work, id, 1800, 1200);
      await published(id);
      const snap = (await query('select live_snapshot s from entries where id = $1', [id])).rows[0].s;
      for (const img of snap.images) {
        const thumb = s3.objects.get('/public-media/' + new URL(img.thumb_url).pathname.replace(/^\//, ''));
        const large = s3.objects.get('/public-media/' + new URL(img.url).pathname.replace(/^\//, ''));
        const tm = await sharp(thumb.body).metadata(); const lm = await sharp(large.body).metadata();
        assert.deepStrictEqual([img.thumb_width, img.thumb_height], [tm.width, tm.height], 'stored small size is the real one');
        assert.deepStrictEqual([img.width, img.height], [lm.width, lm.height], 'stored large size is the real one');
      }
      const first = snap.images[0];
      const tm = await sharp(s3.objects.get('/public-media/' + new URL(first.thumb_url).pathname.replace(/^\//, '')).body).metadata();
      assert.deepStrictEqual([tm.width, tm.height], [427, 640], 'the portrait small copy really is 427 x 640');
      const feed = await (await fetch(app.origin + '/api/feed')).json();
      const item = feed.items.find((i) => i.title === 'Tall photo first job');
      assert.deepStrictEqual([item.image.width, item.image.height], [427, 640]);
      const html = await (await fetch(app.origin + '/our-work')).text();
      assert.ok(html.includes('src="' + first.thumb_url + '" alt="Photo" width="427" height="640"'), 'list page carries the same size');
    });
    it('a snapshot made before the sizes were stored is still given the right shape', async () => {
      const id = await newEntry(work, { title: 'Older snapshot job' });
      await addPhoto(work, id, 1200, 1800);
      await published(id);
      const old = (await query('select live_snapshot s from entries where id = $1', [id])).rows[0].s;
      old.images.forEach((i) => { delete i.thumb_width; delete i.thumb_height; });
      await query('update entries set live_snapshot = $2 where id = $1', [id, JSON.stringify(old)]);
      const item = (await (await fetch(app.origin + '/api/feed')).json()).items.find((i) => i.title === 'Older snapshot job');
      assert.deepStrictEqual([item.image.width, item.image.height], [Math.round(old.images[0].width * 640 / old.images[0].height), 640]);
    });
  });

  describe('4. removing a photo', () => {
    it('removes its private original and leaves the others, and closes the gap in the order', async () => {
      const id = await newEntry(work, { title: 'Remove from draft' });
      const a = await addPhoto(work, id); const b = await addPhoto(work, id);
      assert.strictEqual(privateOf(id).length, 2);
      assert.strictEqual((await work.del('/images/' + a)).status, 200);
      assert.deepStrictEqual(privateOf(id), ['/private-originals/originals/' + id + '/' + b]);
      assert.deepStrictEqual((await rows(id)).map((r) => [r.id, r.position]), [[b, 0]]);
    });
    it('an approved entry that was never made public: the photo, its original and both unused public copies go; the entry returns to draft', async () => {
      const id = await newEntry(work, { title: 'Remove from approved' });
      const a = await addPhoto(work, id); const b = await addPhoto(work, id);
      await approved(id);
      assert.strictEqual(publicOf(id).length, 4);
      assert.strictEqual((await editor.del('/images/' + a)).status, 200);
      assert.strictEqual(publicOf(id).length, 2, 'only the other photo\'s two copies remain');
      assert.ok(publicOf(id).every((k) => k.includes('/' + b + '-')));
      assert.deepStrictEqual(privateOf(id), ['/private-originals/originals/' + id + '/' + b]);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'draft');
    });
    it('a photo on the live website keeps its public copies until the site is republished without it; then they are released', async () => {
      const id = await newEntry(work, { title: 'Remove from live' });
      const a = await addPhoto(work, id); const b = await addPhoto(work, id);
      await published(id);
      assert.strictEqual((await editor.del('/images/' + a)).status, 200);
      assert.strictEqual(privateOf(id).length, 1, 'original removed');
      assert.strictEqual(publicOf(id).length, 4, 'the live page still shows the photo, so its copies stay');
      assert.strictEqual(await E.releasePublicCopies(), 0, 'nothing released while it is live');
      await published(id);   // re-approved and re-published without photo a
      assert.strictEqual(await E.releasePublicCopies(), 2);
      assert.strictEqual(publicOf(id).length, 2);
      assert.ok(publicOf(id).every((k) => k.includes('/' + b + '-')));
      assert.strictEqual(await E.releasePublicCopies(), 0, 'safe to run again');
    });
    it('retained copies of an entry that has since been deleted are released once, not on every run', async () => {
      const id = await newEntry(work, { title: 'Deleted later' });
      const a = await addPhoto(work, id); await addPhoto(work, id);
      await published(id);
      assert.strictEqual((await editor.del('/images/' + a)).status, 200);
      await query('delete from entries where id = $1', [id]);
      assert.strictEqual(await E.releasePublicCopies(), 2);
      assert.strictEqual(await E.releasePublicCopies(), 0, 'not repeated');
    });
    it('a photo used by a Buffer draft keeps its public copies, even after the website is republished', async () => {
      const id = await newEntry(work, { title: 'Remove from linkedin' });
      const a = await addPhoto(work, id); await addPhoto(work, id);
      assert.strictEqual((await editor.patch('/entries/' + id, { destinations: { website: true, linkedin: true } })).status, 200);
      assert.strictEqual((await editor.post('/entries/' + id + '/caption', { save: true })).status, 200);
      await published(id);
      assert.strictEqual((await editor.del('/images/' + a)).status, 200);
      assert.strictEqual(publicOf(id).length, 4);
      assert.strictEqual(await E.releasePublicCopies(), 0);
      assert.strictEqual(publicOf(id).length, 4, 'the draft in Buffer still points at them');
    });
    it('never touches another entry\'s files', async () => {
      const one = await newEntry(work, { title: 'Isolation one' }); const two = await newEntry(work, { title: 'Isolation two' });
      const a = await addPhoto(work, one); await addPhoto(work, two);
      await approved(two);
      const before = { priv: privateOf(two).slice().sort(), pub: publicOf(two).slice().sort() };
      assert.strictEqual((await work.del('/images/' + a)).status, 200);
      assert.deepStrictEqual({ priv: privateOf(two).slice().sort(), pub: publicOf(two).slice().sort() }, before);
    });
    it('an object that cannot be deleted is recorded in the audit history instead of being forgotten, and a later cleanup removes it', async () => {
      const { storage } = require('../api/_lib/s3');
      const id = await newEntry(work, { title: 'Delete fails' });
      const a = await addPhoto(work, id);
      const key = privateOf(id)[0].replace('/private-originals/', '');
      const realDel = storage.del; storage.del = async () => { throw new Error('storage unavailable'); };
      const quiet = console.error; console.error = () => {};
      try { assert.strictEqual((await work.del('/images/' + a)).status, 200, 'the photo is removed from the entry anyway'); } finally { storage.del = realDel; console.error = quiet; }
      assert.strictEqual(privateOf(id).length, 1, 'the object is still there');
      const rec = (await query("select detail from audit_log where entry_id = $1 and action = 'storage_delete_failed'", [id])).rows;
      assert.strictEqual(rec.length, 1);
      assert.deepStrictEqual(rec[0].detail.keys, ['private:' + key]);
    });
    it('another workshop user cannot remove someone else\'s photo', async () => {
      const auth = require('../api/_lib/auth');
      await auth.createUser({ email: 'seed@test' }, { email: 'work3@jnr.test', name: 'Workshop Three', role: 'workshop', password: PW });
      const other = app.client(); assert.strictEqual((await other.login('work3@jnr.test', PW)).status, 200);
      const id = await newEntry(work, { title: 'Not yours' }); const a = await addPhoto(work, id);
      const r = await other.del('/images/' + a);
      assert.ok(r.status === 403 || r.status === 404, 'refused, got ' + r.status);
      assert.strictEqual(privateOf(id).length, 1);
    });
  });
});

describe('5. staging end-to-end script cleans up after itself', { skip: SKIP }, () => {
  it('the self-test proves no original, large copy or small copy is left in either bucket', () => {
    const r = spawnSync(process.execPath, ['scripts/staging-e2e.js', '--selftest'], { cwd: ROOT, env: Object.assign({}, process.env), encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const m = /PASS\s+no test photo objects left in either bucket \(originals, large and small public copies\)\s+-\s+(\d+) checked/.exec(r.stdout);
    assert.ok(m, 'the cleanup proof line is printed:\n' + r.stdout);
    assert.ok(Number(m[1]) >= 6, 'two photos x (original + large + small) were checked, got ' + m[1]);
  });
  it('when the Buffer draft cannot be deleted, the photos are kept on purpose and the script says how to finish by hand', () => {
    const r = spawnSync(process.execPath, ['scripts/staging-e2e.js', '--selftest'], { cwd: ROOT, env: Object.assign({}, process.env, { SELFTEST_DELETE_FAILS: '1' }), encoding: 'utf8', timeout: 120000 });
    assert.match(r.stdout, /public photos KEPT/);
    assert.match(r.stdout, /TO FINISH CLEANING UP BY HAND/);
    assert.ok(!/no test photo objects left/.test(r.stdout));
  });
});
