'use strict';
// The browser-only setup path: db/browser-setup.sql must build exactly the same database as `npm run migrate`, and an
// administrator created with plain SQL (pbkdf2 hash) must sign in and be upgraded to scrypt.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const H = require('../testlib/harness');

const root = path.join(__dirname, '..');
const SKIP = H.BASE ? false : 'set TEST_DATABASE_URL to a Postgres server to run the database tests';

describe('browser-setup.sql', () => {
  it('is up to date with db/migrations and holds no secrets', () => {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-browser-sql.js'), '--check'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const sql = require('node:fs').readFileSync(path.join(root, 'db', 'browser-setup.sql'), 'utf8');
    assert.ok(!/postgres(ql)?:\/\/|Bearer\s|AKIA[0-9A-Z]{12}|sk-[A-Za-z0-9]{10}|\b[a-f0-9]{40,}\b|scrypt\$|pbkdf2\$/.test(sql), 'no connection string, key, token or password hash in the file');
    assert.match(sql, /^begin;/m); assert.match(sql, /^commit;/m);
  });
});

describe('browser-setup.sql against real Postgres', { skip: SKIP }, () => {
  const names = []; let admin;
  const urlFor = (name) => { const u = new URL(H.BASE); u.pathname = '/' + name; return u.toString(); };
  const mkdb = async () => { const n = 'jnr_bs_' + crypto.randomBytes(5).toString('hex'); await admin.query('create database ' + n); names.push(n); return n; };
  const psql = (name, file) => spawnSync('psql', [urlFor(name), '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], { encoding: 'utf8' });
  async function shape(name) {
    const c = new Client({ connectionString: urlFor(name) }); await c.connect();
    const q = async (sql) => (await c.query(sql)).rows;
    const out = {
      columns: await q("select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by 1, ordinal_position"),
      indexes: await q("select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2"),
      constraints: await q("select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2"),
      rls: await q("select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' order by 1"),
      migrations: await q('select name from schema_migrations order by 1'),
    };
    await c.end(); return out;
  }
  before(async () => { admin = new Client({ connectionString: H.BASE }); await admin.connect(); });
  after(async () => { for (const n of names) await admin.query('drop database if exists ' + n + ' with (force)'); await admin.end(); });

  it('builds the identical schema, indexes, constraints, row level security and migration record as npm run migrate', async () => {
    const a = await mkdb(); const b = await mkdb();
    const r = psql(a, path.join(root, 'db', 'browser-setup.sql')); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const m = spawnSync(process.execPath, [path.join(root, 'scripts', 'migrate.js')], { env: Object.assign({}, process.env, { DATABASE_URL: urlFor(b) }), encoding: 'utf8' });
    assert.strictEqual(m.status, 0, m.stdout + m.stderr);
    const sa = await shape(a), sb = await shape(b);
    assert.ok(sa.columns.length > 60 && sa.rls.length === 8);
    assert.deepStrictEqual(sa.columns, sb.columns); assert.deepStrictEqual(sa.indexes, sb.indexes); assert.deepStrictEqual(sa.constraints, sb.constraints);
    assert.deepStrictEqual(sa.rls, sb.rls); sa.rls.forEach((t) => assert.strictEqual(t.relrowsecurity, true));
    assert.deepStrictEqual(sa.migrations.map((x) => x.name), ['001_workshop_content.sql', '002_lock_down_tables.sql']);
    assert.deepStrictEqual(sa.migrations, sb.migrations);
  });

  it('refuses to run twice, with a plain message, and changes nothing', async () => {
    const a = await mkdb(); const file = path.join(root, 'db', 'browser-setup.sql');
    assert.strictEqual(psql(a, file).status, 0);
    const before = JSON.stringify(await shape(a));
    const again = psql(a, file);
    assert.notStrictEqual(again.status, 0); assert.match(again.stderr, /already been run on this database\. Nothing was changed/);
    assert.strictEqual(JSON.stringify(await shape(a)), before);
  });

  it('leaves nothing behind if it fails part way (one transaction)', async () => {
    const a = await mkdb();
    const c = new Client({ connectionString: urlFor(a) }); await c.connect(); await c.query('create table entries (x int)'); await c.end(); // simulates a half-set-up database
    const r = psql(a, path.join(root, 'db', 'browser-setup.sql')); assert.notStrictEqual(r.status, 0);
    const c2 = new Client({ connectionString: urlFor(a) }); await c2.connect();
    assert.strictEqual((await c2.query("select count(*)::int n from pg_tables where schemaname = 'public'")).rows[0].n, 1, 'only the pre-existing table');
    await c2.end();
  });

  it('npm run migrate afterwards skips both files instead of repeating them', async () => {
    const a = await mkdb(); assert.strictEqual(psql(a, path.join(root, 'db', 'browser-setup.sql')).status, 0);
    const m = spawnSync(process.execPath, [path.join(root, 'scripts', 'migrate.js')], { env: Object.assign({}, process.env, { DATABASE_URL: urlFor(a) }), encoding: 'utf8' });
    assert.strictEqual(m.status, 0, m.stdout + m.stderr); assert.match(m.stdout, /skip\s+001_workshop_content\.sql/); assert.match(m.stdout, /skip\s+002_lock_down_tables\.sql/); assert.ok(!/apply/.test(m.stdout));
  });
});

describe('an administrator created or reset with plain SQL (pbkdf2 hash accepted, upgraded to scrypt)', () => {
  const { verifyPassword } = require('../api/_lib/auth');
  const PW = 'purple tractor wins every tuesday';
  // Same format a browser (WebCrypto) or any PBKDF2 tool can produce: pbkdf2$<iterations>$<salt b64>$<hash b64>
  const make = (pw, iterations) => { const salt = crypto.randomBytes(16); return 'pbkdf2$' + iterations + '$' + salt.toString('base64') + '$' + crypto.pbkdf2Sync(pw, salt, iterations, 32, 'sha256').toString('base64'); };

  it('verifies a PBKDF2 hash with the OWASP cost and rejects a wrong password', async () => {
    const h = make(PW, 600000);
    assert.strictEqual(await verifyPassword(PW, h), true);
    assert.strictEqual(await verifyPassword(PW + 'x', h), false);
  });
  it('refuses a stored hash with an absurd or too-small cost', async () => {
    assert.strictEqual(await verifyPassword(PW, 'pbkdf2$1$AAAA$AAAA'), false);
    assert.strictEqual(await verifyPassword(PW, 'pbkdf2$999999999$AAAA$AAAA'), false);
  });
  describe('in the database', { skip: SKIP }, () => {
    let db, s3, buf, app;
    before(async () => { db = await H.createTestDb(); s3 = await H.startFakeS3(); buf = await H.startFakeBuffer(); H.setEnv(s3, buf); app = await H.startApp(); });
    after(async () => { await app.close(); await s3.close(); await buf.close(); await db.drop(); });
    it('signs in with a pbkdf2 hash and replaces it with scrypt at the first sign-in', async () => {
      const { query } = require('../api/_lib/db');
      await query("insert into users (email, name, role, password_hash) values ('first@jnr.test', 'First Admin', 'admin', $1)", [make(PW, 600000)]);
      const c = app.client();
      assert.strictEqual((await c.login('first@jnr.test', 'wrong password at all')).status, 401);
      assert.match((await query("select password_hash from users where email = 'first@jnr.test'")).rows[0].password_hash, /^pbkdf2\$/, 'a failed sign-in does not change the hash');
      const ok = await c.login('first@jnr.test', PW);
      assert.strictEqual(ok.status, 200); assert.strictEqual(ok.data.user.role, 'admin');
      assert.match((await query("select password_hash from users where email = 'first@jnr.test'")).rows[0].password_hash, /^scrypt\$65536\$/, 'upgraded to scrypt');
      assert.strictEqual((await app.client().login('first@jnr.test', PW)).status, 200, 'and still signs in afterwards');
    });
  });
});
