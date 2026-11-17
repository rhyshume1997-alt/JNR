'use strict';
// The JNR writing guide (the voice for AI-written LinkedIn posts) and the private "in your own words" box.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const H = require('../testlib/harness');
const G = require('../api/_lib/writing-guide');
const { scanPublicText } = require('../api/_lib/confidential');

const SKIP = H.BASE ? false : 'set TEST_DATABASE_URL to a Postgres server to run the database tests';
const PW = 'correct horse battery staple';
const all = (g) => [g.style, g.length, g.emoji, g.hashtags, g.customers, g.photos, g.sign_off.text].concat(g.never_say, g.examples.map((e) => e.text), g.brands.map((b) => b.note + ' ' + b.name)).join('\n');

describe('first version of the writing guide (no database)', () => {
  const g = G.DEFAULT_GUIDE;
  it('follows the answers Rhys gave: friendly and chatty, one short paragraph, no emoji, no hashtags, British spelling and mm, no location', () => {
    assert.match(g.style, /friendly, chatty/i); assert.match(g.style, /proud/i); assert.match(g.style, /friend/i);
    assert.match(g.style, /British spelling/i); assert.match(g.style, /\bmm\b/);
    assert.match(g.length, /one short paragraph/i);
    assert.match(g.emoji, /do not use emoji/i); assert.match(g.hashtags, /do not use hashtags/i);
    assert.ok(g.never_say.some((s) => /where the workshop is/i.test(s)), 'location is never mentioned');
    assert.ok(!/hamilton|scotland|lanarkshire/i.test(all(g)), 'the guide itself never names a place');
  });
  it('posts for either company, and the sign-off is optional with an empty default John can set', () => {
    assert.deepStrictEqual(g.brands.map((b) => b.id), ['jnr', 'marpet']);
    assert.deepStrictEqual(g.sign_off, { text: '', use_by_default: false });
  });
  it('customers are named only when allowed, otherwise a general label; photos are mentioned only when described', () => {
    assert.match(g.customers, /only use a customer's name when the request says naming them is allowed/i);
    assert.match(g.customers, /a customer/i);
    assert.match(g.photos, /never describe what a photo shows unless it was described/i);
  });
  it('only supplied facts: the guide forbids invented details, prices, promises and superlatives', () => {
    const t = g.never_say.join(' ');
    assert.match(t, /not in the job notes/i); assert.match(t, /prices/i); assert.match(t, /best, cheapest, fastest/i);
  });
  it('the samples are labelled, contain only [placeholders], and no invented facts, numbers or names', () => {
    assert.strictEqual(g.examples.length, 3);
    g.examples.forEach((e) => {
      assert.strictEqual(e.source, 'sample'); assert.match(e.title, /^SAMPLE/); assert.match(e.text, /^SAMPLE \(a structure only, not a real post, not a real job\)/);
      assert.match(e.text, /\[[^\]]+\]/, 'has placeholders');
      assert.ok(!/\d/.test(e.text), 'no numbers at all: ' + e.text);
      assert.ok(!/ltd|limited|plc|marine|stainless|aluminium/i.test(e.text), 'no real-sounding job details');
    });
  });
  it('passes the same confidentiality checks as public text, and validates as saved', () => {
    const r = scanPublicText({ summary: all(g) });
    assert.deepStrictEqual(r.blocking, [], JSON.stringify(r.blocking));
    assert.doesNotThrow(() => G.validate(g));
  });
  it('validation: needs a company and a style, limits sizes, and refuses confidential text that would be sent with every request', () => {
    const bad = (patch, re) => assert.throws(() => G.validate(Object.assign(JSON.parse(JSON.stringify(g)), patch)), re);
    bad({ brands: [] }, /at least one company/i);
    bad({ style: 'short' }, /few sentences/i);
    bad({ style: 'x'.repeat(4001) }, /too long/i);
    bad({ never_say: ['Never mention buyer@acme.com'] }, /must not be sent to the AI/);
    bad({ examples: [{ title: 'Real one', text: 'Ring us on 07700 900123 about PO 4500012345.' }] }, /must not be sent to the AI/);
    bad({ sign_off: { text: 'Email john@jnr.example', use_by_default: true } }, /must not be sent to the AI/);
  });
  it('examples for a request: real published posts first, then samples, never more than asked for', () => {
    const guide = JSON.parse(JSON.stringify(g));
    guide.examples.push({ id: 'post-1', source: 'published', title: 'Real', text: 'A real post.' });
    assert.deepStrictEqual(G.examplesForPrompt(guide, 3).map((e) => e.id), ['post-1', 'sample-1', 'sample-2']);
    assert.strictEqual(G.examplesForPrompt(guide, 1).length, 1);
  });
});

describe('writing guide setting and the private job-notes box (database)', { skip: SKIP }, () => {
  let db, s3, buf, app, admin, editor, editor2, work, query;
  before(async () => {
    db = await H.createTestDb(); s3 = await H.startFakeS3(); buf = await H.startFakeBuffer(); H.setEnv(s3, buf);
    app = await H.startApp(); query = require('../api/_lib/db').query;
    const auth = require('../api/_lib/auth'); const boss = { email: 'seed@test' };
    for (const [email, role] of [['admin@jnr.test', 'admin'], ['editor@jnr.test', 'editor'], ['editor2@jnr.test', 'editor'], ['work@jnr.test', 'workshop']]) await auth.createUser(boss, { email, name: email.split('@')[0], role, password: PW });
    admin = app.client(); editor = app.client(); editor2 = app.client(); work = app.client();
    for (const [c, e] of [[admin, 'admin@jnr.test'], [editor, 'editor@jnr.test'], [editor2, 'editor2@jnr.test'], [work, 'work@jnr.test']]) assert.strictEqual((await c.login(e, PW)).status, 200);
  });
  after(async () => { await app.close(); await s3.close(); await buf.close(); await db.drop(); });

  const base = (o) => Object.assign({ kind: 'completed', title: 'Bracket set', summary: 'Brackets turned and drilled.', material: '316 stainless steel', process: 'CNC turning', stage: 'delivered' }, o || {});
  const mk = async (c, o) => { const r = await c.post('/entries', base(o), { 'idempotency-key': crypto.randomUUID() }); assert.strictEqual(r.status, 201, JSON.stringify(r.data)); return r.data.entry.id; };

  describe('the guide setting', () => {
    it('starts as the first version (not yet saved), for editors and admins only', async () => {
      const r = await editor.get('/writing-guide');
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.saved, false); assert.strictEqual(r.data.version, 0);
      assert.strictEqual(r.data.guide.brands.length, 2);
      assert.strictEqual((await work.get('/writing-guide')).status, 403);
      assert.strictEqual((await app.client().get('/writing-guide')).status, 401);
      assert.strictEqual((await work.put('/writing-guide', r.data.guide)).status, 403);
    });
    it('saves edits as new versions, keeps the history, audits who changed it, and guards against two people editing at once', async () => {
      const first = (await editor.get('/writing-guide')).data;
      const edited = JSON.parse(JSON.stringify(first.guide)); edited.sign_off = { text: 'Got a job to make? Send us the drawing.', use_by_default: true };
      const s1 = await editor.put('/writing-guide', Object.assign({}, edited, { version: 0 }));
      assert.strictEqual(s1.status, 200, JSON.stringify(s1.data)); assert.strictEqual(s1.data.version, 1);
      const again = (await admin.get('/writing-guide')).data;
      assert.strictEqual(again.saved, true); assert.strictEqual(again.guide.sign_off.text, 'Got a job to make? Send us the drawing.'); assert.strictEqual(again.guide.sign_off.use_by_default, true);
      edited.emoji = 'A thumbs-up is fine now and then.';
      assert.strictEqual((await admin.put('/writing-guide', Object.assign({}, edited, { version: 1 }))).data.version, 2);
      const stale = await editor.put('/writing-guide', Object.assign({}, edited, { version: 1 }));
      assert.strictEqual(stale.status, 409);
      const hist = (await admin.get('/writing-guide')).data.history;
      assert.deepStrictEqual(hist.map((h) => h.version), [2, 1]); assert.strictEqual(hist[1].updated_by, 'editor@jnr.test');
      assert.strictEqual((await query("select count(*)::int n from audit_log where action = 'writing_guide_updated'")).rows[0].n, 2);
    });
    it('restores an earlier version as a new version, never rewriting history', async () => {
      const r = await editor.post('/writing-guide/restore/1');
      assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.version, 3);
      assert.strictEqual(r.data.guide.emoji, G.DEFAULT_GUIDE.emoji, 'version 1 had the original emoji line');
      assert.strictEqual((await editor.post('/writing-guide/restore/99')).status, 404);
    });
    it('refuses to save text that would send confidential details to the AI with every request', async () => {
      const g = JSON.parse(JSON.stringify((await editor.get('/writing-guide')).data.guide)); g.style += '\nAsk for jane@acme-marine.com.';
      const r = await editor.put('/writing-guide', g);
      assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'confidential');
    });
  });

  describe('"use as a style example"', () => {
    async function published(title, caption) {
      const id = await mk(work, { title });
      const up = await H.uploadImage(work, id, await H.jpegWithExif(1200, 800, '#334455'), 'image/jpeg', 'a.jpg');
      await work.patch('/images/' + up.imageId, { cleared_for_public: true });
      assert.strictEqual((await editor.patch('/entries/' + id, { caption })).status, 200);
      assert.strictEqual((await work.post('/entries/' + id + '/submit')).status, 200);
      assert.strictEqual((await editor2.post('/entries/' + id + '/approve', {})).status, 200);
      assert.strictEqual((await editor2.post('/entries/' + id + '/publish')).data.status, 'published');
      return id;
    }
    it('adds the approved caption of a published post to the examples (editors and admins only), once', async () => {
      const id = await published('Example job', 'We made a batch of brackets this week and they are off to their new home.');
      assert.strictEqual((await work.post('/entries/' + id + '/style-example')).status, 403);
      const r = await editor.post('/entries/' + id + '/style-example');
      assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      const g = (await editor.get('/writing-guide')).data.guide;
      const ex = g.examples.find((e) => e.entry_id === id);
      assert.ok(ex && ex.source === 'published'); assert.strictEqual(ex.text, 'We made a batch of brackets this week and they are off to their new home.');
      assert.strictEqual(G.examplesForPrompt(g, 3)[0].id, ex.id, 'real posts come before samples');
      const dup = await editor.post('/entries/' + id + '/style-example'); assert.strictEqual(dup.data.already, true);
      assert.strictEqual((await editor.get('/writing-guide')).data.guide.examples.filter((e) => e.entry_id === id).length, 1);
    });
    it('refuses an entry that is not published or has no caption', async () => {
      const id = await mk(work, { title: 'Not published' });
      assert.strictEqual((await editor.post('/entries/' + id + '/style-example')).status, 409);
    });
    it('keeps a caption that contains something confidential out of the guide (checked again when it is added)', async () => {
      const id = await published('Leaky caption job', 'A clean caption at the time.');
      const live = (await query('select live_snapshot from entries where id = $1', [id])).rows[0].live_snapshot;
      live.caption = 'Done for buyer@acme-marine.com, see PO 4500012345.';
      await query('update entries set live_snapshot = $2 where id = $1', [id, JSON.stringify(live)]);
      const r = await editor.post('/entries/' + id + '/style-example');
      assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'confidential');
    });
  });

  describe('the private "in your own words" box', () => {
    it('is saved with the entry, editable, visible to its author and the office, and never part of anything public', async () => {
      const notes = 'Made these for a boat people. Tricky bit was the thin wall. Really chuffed with the finish. secret-marker-9931';
      const id = await mk(work, { title: 'Notes job', rough_notes: notes });
      const got = (await work.get('/entries/' + id)).data.entry;
      assert.strictEqual(got.rough_notes, notes);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.rough_notes, notes);
      assert.strictEqual((await editor.patch('/entries/' + id, { rough_notes: notes + ' Edited.' })).status, 200);
      const up = await H.uploadImage(work, id, await H.jpegWithExif(1200, 800, '#445566'), 'image/jpeg', 'b.jpg');
      await work.patch('/images/' + up.imageId, { cleared_for_public: true });
      assert.strictEqual((await editor.post('/entries/' + id + '/caption', { save: true })).status, 200);
      assert.strictEqual((await work.post('/entries/' + id + '/submit')).status, 200);
      assert.strictEqual((await editor2.post('/entries/' + id + '/approve', {})).status, 200);
      assert.strictEqual((await editor2.post('/entries/' + id + '/publish')).data.status, 'published');
      const pub = [await (await fetch(app.origin + '/our-work')).text(), JSON.stringify(await (await fetch(app.origin + '/api/feed')).json()), await (await fetch(app.origin + '/sitemap-work.xml')).text(),
        JSON.stringify((await query('select approved_snapshot, live_snapshot from entries where id = $1', [id])).rows[0])].join('\n');
      assert.ok(!pub.includes('secret-marker-9931') && !pub.includes('chuffed'), 'the notes are not in any public output or snapshot');
      const audit = JSON.stringify((await query('select detail from audit_log where entry_id = $1', [id])).rows);
      assert.ok(!audit.includes('secret-marker-9931') && audit.includes('rough_notes'), 'the audit history records the field name only');
    });
    it('does not count as a change to what is published: editing the notes does not send an approved entry back to draft or block the editor approving', async () => {
      const id = await mk(work, { title: 'Notes only change' });
      assert.strictEqual((await work.post('/entries/' + id + '/submit')).status, 200);
      assert.strictEqual((await editor.patch('/entries/' + id, { rough_notes: 'Added by the office.' })).status, 200);
      assert.strictEqual((await editor.post('/entries/' + id + '/approve', {})).status, 200, 'review work, not a content change');
      assert.strictEqual((await editor.patch('/entries/' + id, { rough_notes: 'Edited later.' })).status, 200);
      assert.strictEqual((await editor.get('/entries/' + id)).data.entry.status, 'approved');
    });
    it('is limited to 4000 characters', async () => {
      const r = await work.post('/entries', base({ rough_notes: 'x'.repeat(4001) }), { 'idempotency-key': crypto.randomUUID() });
      assert.strictEqual(r.status, 422);
    });
    it('another workshop user cannot read it', async () => {
      const auth = require('../api/_lib/auth'); await auth.createUser({ email: 'seed@test' }, { email: 'work9@jnr.test', name: 'w9', role: 'workshop', password: PW });
      const other = app.client(); await other.login('work9@jnr.test', PW);
      const id = await mk(work, { title: 'Mine alone', rough_notes: 'keep this' });
      assert.ok([403, 404].includes((await other.get('/entries/' + id)).status));
    });
  });
});
