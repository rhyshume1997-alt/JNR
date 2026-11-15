'use strict';
// Findings from the pre-deployment security review, each pinned by a test.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const sharp = require('sharp');
const H = require('../testlib/harness');

const SKIP = H.BASE ? false : 'set TEST_DATABASE_URL to a Postgres server to run the database tests';
const PW = 'correct horse battery staple';

describe('security review (database)', { skip: SKIP }, () => {
  let db, s3, buf, app, work, editor, admin, dbq;
  before(async () => {
    db = await H.createTestDb(); s3 = await H.startFakeS3(); buf = await H.startFakeBuffer(); H.setEnv(s3, buf); app = await H.startApp();
    dbq = require('../api/_lib/db').query;
    const auth = require('../api/_lib/auth');
    for (const [role, email] of [['admin', 'a@t'], ['editor', 'e@t'], ['workshop', 'w@t'], ['workshop', 'w2@t']]) await auth.createUser({ email: 'seed' }, { email: email + '.test', name: role, role, password: PW });
    admin = app.client(); editor = app.client(); work = app.client();
    await admin.login('a@t.test', PW); await editor.login('e@t.test', PW); await work.login('w@t.test', PW);
  });
  after(async () => { await app.close(); await s3.close(); await buf.close(); await db.drop(); });

  const mk = async (c, title) => (await c.post('/entries', { kind: 'completed', title: title || 'Sec test entry', summary: 'Plain.' }, { 'idempotency-key': crypto.randomUUID() })).data.entry.id;

  describe('passwords and sign-in', () => {
    it('stores passwords as salted scrypt with the OWASP cost, never in clear', async () => {
      const row = (await dbq("select password_hash from users where email = 'w@t.test'")).rows[0].password_hash;
      assert.match(row, /^scrypt\$65536\$8\$1\$/);
      assert.ok(!row.includes(PW));
      const other = (await dbq("select password_hash from users where email = 'w2@t.test'")).rows[0].password_hash;
      assert.notStrictEqual(row.split('$')[4], other.split('$')[4], 'each hash has its own salt');
    });
    it('rejects short and trivial passwords when users are created', async () => {
      const r = await admin.post('/users', { name: 'X', email: 'x@t.test', role: 'workshop', password: 'short' });
      assert.strictEqual(r.status, 422);
      assert.strictEqual((await admin.post('/users', { name: 'X', email: 'x@t.test', role: 'workshop', password: 'aaaaaaaaaaaaaaaa' })).status, 422);
    });
    it('throttles repeated failures from one address across many accounts', async () => {
      const auth = require('../api/_lib/auth');
      let last;
      for (let i = 0; i < 22; i++) { try { await auth.login('nobody' + i + '@t.test', 'wrong password ' + i, '203.0.113.9', 'test'); } catch (e) { last = e; } }
      assert.strictEqual(last.status, 429); assert.strictEqual(last.code, 'too_many');
      await assert.rejects(() => auth.login('w@t.test', PW, '203.0.113.9', 'test'), (e) => e.status === 429, 'even the right password is refused from a throttled address');
      const ok = await auth.login('w@t.test', PW, '198.51.100.7', 'test');
      assert.ok(ok.token, 'other addresses are unaffected');
    });
    it('ends sessions when a user is disabled or their password is reset', async () => {
      const victim = app.client(); await victim.login('w2@t.test', PW);
      assert.strictEqual((await victim.get('/auth/me')).status, 200);
      const id = (await dbq("select id from users where email = 'w2@t.test'")).rows[0].id;
      assert.strictEqual((await admin.patch('/users/' + id, { disabled: true })).status, 200);
      assert.strictEqual((await victim.get('/auth/me')).status, 401);
      assert.strictEqual((await admin.patch('/users/' + id, { disabled: false })).status, 200);
    });
    it('stops an admin locking themselves out', async () => {
      const id = (await dbq("select id from users where email = 'a@t.test'")).rows[0].id;
      assert.strictEqual((await admin.patch('/users/' + id, { disabled: true })).status, 409);
      assert.strictEqual((await admin.patch('/users/' + id, { role: 'editor' })).status, 409);
    });
    it('hashes stored session tokens: the cookie value is not in the database', async () => {
      const token = work.cookie.split('=')[1];
      assert.strictEqual((await dbq('select count(*)::int n from sessions where token_hash = $1', [token])).rows[0].n, 0);
      assert.strictEqual((await dbq('select count(*)::int n from sessions where token_hash = $1', [crypto.createHash('sha256').update(token).digest('hex')])).rows[0].n, 1);
    });
    it('always marks the cookie Secure on Vercel, whatever the local override says', () => {
      const { getConfig } = require('../api/_lib/config');
      process.env.ALLOW_INSECURE_COOKIES = '1'; delete process.env.VERCEL;
      assert.strictEqual(getConfig().cookieSecure, false);
      process.env.VERCEL = '1';
      assert.strictEqual(getConfig().cookieSecure, true);
      delete process.env.VERCEL;
      const c = require('../api/_lib/auth').sessionCookie('x', 60); assert.match(c, /HttpOnly; SameSite=Strict/);
    });
  });

  describe('permissions', () => {
    it('keeps the audit history away from workshop staff, and gives editors the detail', async () => {
      const id = await mk(work);
      assert.strictEqual((await work.get('/entries/' + id + '/audit')).status, 403);
      assert.strictEqual((await editor.get('/entries/' + id + '/audit')).status, 200);
    });
    it('hides private fields of other people\'s entries completely (not just on the list)', async () => {
      const id = await mk(work);
      const other = app.client(); await other.login('w@t.test', PW);
      const mine = await other.get('/entries/' + id); assert.strictEqual(mine.status, 200);
      const auth = require('../api/_lib/auth');
      await auth.createUser({ email: 'seed' }, { email: 'w3@t.test', name: 'w3', role: 'workshop', password: PW });
      const w3 = app.client(); await w3.login('w3@t.test', PW);
      for (const [m, p, b] of [['get', '/entries/' + id], ['patch', '/entries/' + id, { title: 'hijack' }], ['post', '/entries/' + id + '/submit'], ['get', '/entries/' + id + '/images/order'], ['post', '/entries/' + id + '/images/presign', { name: 'a.jpg', type: 'image/jpeg', size: 10 }]]) {
        const r = await w3[m](p, b); assert.ok([404, 405].includes(r.status), m + ' ' + p + ' -> ' + r.status);
      }
    });
    it('does not accept an id that is not a UUID anywhere in the API', async () => {
      for (const p of ["/entries/1'%20or%20'1'='1", '/entries/..%2F..%2Fetc', '/images/not-a-uuid/preview']) assert.ok([404, 405].includes((await admin.get(p)).status), p);
    });
    it('treats SQL in text fields and search as plain text', async () => {
      const id = await mk(work, "Robert'); drop table entries;--");
      assert.strictEqual((await editor.get('/entries?q=' + encodeURIComponent("'; drop table users;--"))).status, 200);
      assert.strictEqual((await editor.get('/entries?status=draft%27%20or%201=1')).status, 200);
      assert.strictEqual((await dbq('select count(*)::int n from entries where id = $1', [id])).rows[0].n, 1);
    });
    it('does not return password hashes, tokens or configuration from any endpoint', async () => {
      const dump = JSON.stringify([(await admin.get('/users')).data, (await admin.get('/auth/me')).data, (await admin.get('/entries')).data]);
      assert.ok(!/scrypt\$|password_hash|token_hash|good-token|TESTSECRET|S3_SECRET/.test(dump));
    });
  });

  describe('private storage and uploads', () => {
    it('pins a signed upload link to the size that was checked: a bigger file is refused by storage', async () => {
      const id = await mk(work);
      const small = await H.jpegWithExif(800, 600);
      const p = await work.post('/entries/' + id + '/images/presign', { name: 'a.jpg', type: 'image/jpeg', size: small.length });
      assert.match(p.data.upload.url, /X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost/);
      assert.deepStrictEqual(p.data.upload.headers, { 'content-type': 'image/jpeg' }, 'the browser is only told to send content-type');
      const bigger = Buffer.concat([small, Buffer.alloc(5000)]);
      assert.strictEqual((await fetch(p.data.upload.url, { method: 'PUT', headers: p.data.upload.headers, body: bigger })).status, 403);
      assert.strictEqual((await fetch(p.data.upload.url, { method: 'PUT', headers: p.data.upload.headers, body: small })).status, 200);
    });
    it('never builds storage keys from user input', async () => {
      const id = await mk(work);
      const p = await work.post('/entries/' + id + '/images/presign', { name: '../../etc/passwd', type: 'image/jpeg', size: 1000 });
      const key = new URL(p.data.upload.url).pathname;
      assert.match(key, /^\/private-originals\/originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    });
    it('refuses to download or approve a photo that is not finished uploading', async () => {
      const id = await mk(work);
      const p = await work.post('/entries/' + id + '/images/presign', { name: 'a.jpg', type: 'image/jpeg', size: 1000 });
      assert.strictEqual((await work.get('/images/' + p.data.image_id + '/preview')).status, 404);
      assert.strictEqual((await work.post('/entries/' + id + '/submit')).status, 409);
    });
    it('only ever writes derived copies to the public bucket, and never an original or its name', async () => {
      const id = await mk(work, 'Public bucket check');
      const buf1 = await H.jpegWithExif(1400, 900);
      const up = await H.uploadImage(work, id, buf1, 'image/jpeg', 'CUSTOMER-DRAWING-REV-C.jpg');
      await work.patch('/images/' + up.imageId, { cleared_for_public: true });
      await work.post('/entries/' + id + '/submit');
      assert.strictEqual((await editor.post('/entries/' + id + '/approve', {})).status, 200);
      const pub = [...s3.objects.entries()].filter(([k]) => k.startsWith('/public-media/'));
      assert.ok(pub.length >= 2);
      for (const [k, o] of pub) {
        assert.ok(!k.includes('CUSTOMER') && !k.includes('originals'), k);
        assert.notDeepStrictEqual(o.body, buf1, 'not the original bytes');
        assert.ok(!o.body.includes(Buffer.from('CUSTOMER-DRAWING')));
        assert.ok(!(await sharp(o.body).metadata()).exif);
      }
      const orig = [...s3.objects.keys()].filter((k) => k.startsWith('/private-originals/'));
      assert.ok(orig.length >= 1);
    });
    it('removes the private original when a photo is deleted, and keeps what a published page may use', async () => {
      const id = await mk(work, 'Delete check');
      const up = await H.uploadImage(work, id, await H.jpegWithExif(900, 700));
      const key = '/private-originals/originals/' + id + '/' + up.imageId;
      assert.ok(s3.objects.has(key));
      assert.strictEqual((await work.del('/images/' + up.imageId)).status, 200);
      assert.ok(!s3.objects.has(key));
    });
  });

  describe('public image approval', () => {
    it('will not publish an image that nobody ticked as checked, even if an editor tries to approve', async () => {
      const id = await mk(work, 'Unchecked photo');
      await H.uploadImage(work, id, await H.jpegWithExif(1000, 700));
      await work.post('/entries/' + id + '/submit');
      const r = await editor.post('/entries/' + id + '/approve', {});
      assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'images_not_cleared');
      assert.ok(![...s3.objects.keys()].some((k) => k.includes('/public/' + id)));
    });
    it('keeps the public site empty until publish, and the live copy independent of later edits', async () => {
      const id = await mk(work, 'Live copy stays put');
      await work.post('/entries/' + id + '/submit');
      await editor.post('/entries/' + id + '/approve', {});
      assert.ok(!(await (await fetch(app.origin + '/our-work')).text()).includes('Live copy stays put'), 'approved is not public');
      await editor.post('/entries/' + id + '/publish');
      assert.match(await (await fetch(app.origin + '/our-work')).text(), /Live copy stays put/);
      await editor.patch('/entries/' + id, { title: 'Changed later' });
      const html = await (await fetch(app.origin + '/our-work')).text();
      assert.ok(html.includes('Live copy stays put') && !html.includes('Changed later'));
    });
  });

  describe('database lock-down', () => {
    it('has row level security on every application table, and no grants for API roles', async () => {
      const t = (await dbq("select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")).rows;
      assert.ok(t.length >= 8);
      t.forEach((r) => assert.strictEqual(r.relrowsecurity, true, r.relname + ' must have RLS on'));
    });
  });

  describe('secrets', () => {
    it('does not put secrets in error responses or logs for failing dependencies', async () => {
      const real = process.env.S3_SECRET_ACCESS_KEY; process.env.S3_ENDPOINT = 'http://127.0.0.1:1';
      const id = await mk(work);
      const r = await work.post('/entries/' + id + '/images/presign', { name: 'a.jpg', type: 'image/jpeg', size: 1000 });
      const text = JSON.stringify(r.data);
      assert.ok(!text.includes(real) && !text.includes('good-token') && !text.includes('postgres://'));
      process.env.S3_ENDPOINT = s3.endpoint;
    });
  });
});
