'use strict';
// The staging scripts: independent modes, safe cleanup of the Buffer test draft, and proof they only touch staging.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertStagingTarget, describeTargets } = require('../scripts/lib/guard');
const { lint } = require('../scripts/lib/staging-env');
const H = require('../testlib/harness');

const root = path.join(__dirname, '..');
const SKIP = H.BASE ? false : 'set TEST_DATABASE_URL to a Postgres server to run the database tests';
const good = { DEPLOY_ENV: 'staging', BUFFER_ENV: 'staging', DATABASE_URL: 'postgresql://u:secretpw@ep-x-pooler.neon.tech/neondb?sslmode=require', S3_BUCKET_PRIVATE: 'jnr-staging-private', S3_BUCKET_PUBLIC: 'jnr-staging-public',
  PUBLIC_MEDIA_BASE_URL: 'https://pub-abc.r2.dev', BUFFER_STAGING_CHANNEL_ID: '6afa05fbece6dfde5fd74165', BUFFER_API_TOKEN: 'tok_SECRET_value_1234567890' };

function run(script, args, env) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', script)].concat(args || []), { env: Object.assign({}, process.env, { TEST_DATABASE_URL: H.BASE }, env || {}), encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('staging guard (nothing production)', () => {
  it('accepts a clearly staging environment', () => assert.doesNotThrow(() => assertStagingTarget(good)));
  it('refuses anything that is not explicitly staging', () => {
    const bad = [
      [{ DEPLOY_ENV: undefined }, /DEPLOY_ENV/], [{ DEPLOY_ENV: 'production' }, /DEPLOY_ENV/], [{ BUFFER_ENV: 'production' }, /BUFFER_ENV/], [{ VERCEL_ENV: 'production' }, /production environment/],
      [{ NODE_ENV: 'production' }, /production environment/], [{ S3_BUCKET_PUBLIC: 'jnr-public' }, /staging/], [{ S3_BUCKET_PRIVATE: 'jnr-production-private' }, /production|staging/],
      [{ DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/production?sslmode=require' }, /prod/], [{ DATABASE_URL: 'postgresql://u:p@db.prod.example.com/x' }, /prod/], [{ AI_CAPTIONS_ENABLED: 'true' }, /AI captions/],
    ];
    for (const [patch, re] of bad) assert.throws(() => assertStagingTarget(Object.assign({}, good, patch)), (e) => e.code === 'not_staging' && re.test(e.message), JSON.stringify(patch));
  });
  it('shows what will be touched without any password, key or token', () => {
    const t = describeTargets(good).join('\n');
    assert.match(t, /ep-x-pooler\.neon\.tech/); assert.match(t, /jnr-staging-private/); assert.match(t, /Vercel\s+not contacted/);
    assert.ok(!/secretpw|SECRET_value|tok_/.test(t));
  });
  it('the environment lint also requires staging bucket names and DEPLOY_ENV, and warns to use synthetic photos on r2.dev', () => {
    const env = Object.assign({ S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', S3_ACCESS_KEY_ID: 'a'.repeat(32), S3_SECRET_ACCESS_KEY: 'b'.repeat(64) }, good);
    const r = lint(env); assert.deepStrictEqual(r.problems, []); assert.match(r.warnings.join(' '), /synthetic or non-sensitive photographs only/);
    assert.match(lint(Object.assign({}, env, { S3_BUCKET_PUBLIC: 'jnr-public' })).problems.join(' '), /staging/);
    assert.match(lint(Object.assign({}, env, { DEPLOY_ENV: '' })).problems.join(' '), /DEPLOY_ENV/);
    assert.deepStrictEqual(lint(Object.assign({}, env, { BUFFER_API_TOKEN: '', BUFFER_ENV: '', BUFFER_STAGING_CHANNEL_ID: '' }), { skipBuffer: true }).problems, [], 'Buffer settings are not required when Buffer is skipped');
  });
  it('the scripts never call Vercel, and every delete they run is on the allow-list of rows they created themselves', () => {
    const files = ['staging-check.js', 'staging-e2e.js', 'cleanup-orphans.js', 'migrate.js', 'create-user.js'].map((f) => [f, fs.readFileSync(path.join(root, 'scripts', f), 'utf8')]);
    for (const [f, src] of files) {
      assert.ok(!/api\.vercel\.com|VERCEL_TOKEN|child_process|vercel\s+(env|link|deploy|--prod)|mcp__Vercel/i.test(src), f + ' must not use Vercel');
      assert.ok(!/\b(truncate|drop\s+(table|database|schema))\b/i.test(src), f + ' must not drop or truncate anything');
    }
    const allowed = [
      'delete from audit_log where entry_id = $1', 'delete from entries where id = $1', 'delete from audit_log where actor_email like $1', 'delete from users where id = any($1)',
      'delete from entry_images where id = $1',
    ];
    const found = [];
    for (const [, src] of files) for (const m of src.matchAll(/delete from [a-z_]+ where [^'"`]+/gi)) found.push(m[0].trim());
    assert.ok(found.length >= 5);
    for (const f of found) assert.ok(allowed.includes(f), 'unexpected delete statement: ' + f);
    const e2e = fs.readFileSync(path.join(root, 'scripts', 'staging-e2e.js'), 'utf8');
    assert.match(e2e, /staging-e2e\.invalid/); assert.match(e2e, /assertStagingTarget/);
    assert.match(fs.readFileSync(path.join(root, 'scripts', 'staging-check.js'), 'utf8'), /assertStagingTarget/);
  });
});

describe('Buffer test-draft deletion is narrow', { skip: SKIP }, () => {
  const B = require('../api/_lib/buffer');
  const ch = 'a'.repeat(24);
  async function withBuffer(fn) {
    const buf = await H.startFakeBuffer(); const saved = { u: process.env.BUFFER_API_URL, t: process.env.BUFFER_API_TOKEN, r: process.env.BUFFER_RETRY_DELAYS_MS };
    Object.assign(process.env, { BUFFER_API_URL: buf.url, BUFFER_API_TOKEN: 'good-token', BUFFER_RETRY_DELAYS_MS: '1,1' });
    try { await fn(buf); } finally { Object.assign(process.env, { BUFFER_API_URL: saved.u || '', BUFFER_API_TOKEN: saved.t || '', BUFFER_RETRY_DELAYS_MS: saved.r || '' }); await buf.close(); }
  }
  const make = (buf, text, patch) => { const id = require('node:crypto').randomBytes(12).toString('hex'); buf.state.posts.set(id, Object.assign({ id, text, status: 'draft', channelId: ch, dueAt: null, sentAt: null, assets: [] }, patch || {})); return id; };

  it('deletes only the draft that carries the marker, is still unscheduled and is on the staging channel, then confirms it is gone', async () => {
    await withBuffer(async (buf) => {
      const mine = make(buf, 'Completed: Staging test e2eabc123.\n\nBody'); const other = make(buf, 'A real draft someone is writing');
      assert.strictEqual(await B.deleteTestDraft(mine, { marker: 'Staging test e2eabc123', channelId: ch }), true);
      assert.ok(!buf.state.posts.has(mine) && buf.state.posts.has(other), 'only the test draft is removed');
    });
  });
  it('refuses to delete anything else', async () => {
    await withBuffer(async (buf) => {
      const e = { marker: 'Staging test e2eabc123', channelId: ch };
      const cases = [
        [make(buf, 'Some other post'), e, /marker/], [make(buf, 'Staging test e2eabc123', { status: 'scheduled' }), e, /not an unscheduled draft/],
        [make(buf, 'Staging test e2eabc123', { dueAt: '2027-01-01T09:00:00Z' }), e, /not an unscheduled draft/], [make(buf, 'Staging test e2eabc123', { sentAt: '2027-01-01T09:00:00Z' }), e, /not an unscheduled draft/],
        [make(buf, 'Staging test e2eabc123', { channelId: 'b'.repeat(24) }), e, /different channel/], ['not-an-id', e, /Not a Buffer post id/],
      ];
      for (const [id, exp, re] of cases) await assert.rejects(() => B.deleteTestDraft(id, exp), re);
      await assert.rejects(() => B.deleteTestDraft(make(buf, 'x'), { marker: 'short', channelId: ch }), /Refusing/);
      await assert.rejects(() => B.deleteTestDraft(make(buf, 'x'), { marker: 'Staging test e2eabc123' }), /Refusing/);
      assert.strictEqual(buf.state.posts.size, 6 + 2 - 1, 'nothing was deleted');
    });
  });
  it('reports a failed or untrustworthy deletion instead of claiming success', async () => {
    await withBuffer(async (buf) => {
      const id = make(buf, 'Staging test e2eabc123'); const e = { marker: 'Staging test e2eabc123', channelId: ch };
      buf.state.deleteMode = 'error'; await assert.rejects(() => B.deleteTestDraft(id, e), /would not delete/);
      buf.state.deleteMode = 'noop'; await assert.rejects(() => B.deleteTestDraft(id, e), /still be read/);
    });
  });
});

describe('staging scripts: independent modes and cleanup order (run against local fakes)', { skip: SKIP }, () => {
  it('a rejected Buffer key fails the full check but does not block the database and storage checks', () => {
    const full = run('staging-check.js', ['--selftest'], { SELFTEST_BAD_BUFFER_KEY: '1' });
    assert.strictEqual(full.code, 1); assert.match(full.out, /FAIL\s+Buffer/); assert.match(full.out, /PASS\s+row level security/); assert.match(full.out, /PASS\s+public image URL/);
    const noBuf = run('staging-check.js', ['--selftest', '--skip-buffer'], { SELFTEST_BAD_BUFFER_KEY: '1' });
    assert.strictEqual(noBuf.code, 0, noBuf.out); assert.match(noBuf.out, /SKIP\s+Buffer/); assert.match(noBuf.out, /PASS\s+Postgres connection/); assert.match(noBuf.out, /PASS\s+private bucket is private/); assert.ok(!/FAIL/.test(noBuf.out));
  });
  it('can check just the database, or just storage', () => {
    const db = run('staging-check.js', ['--selftest', '--only=db'], { SELFTEST_BAD_BUFFER_KEY: '1' });
    assert.strictEqual(db.code, 0, db.out); assert.match(db.out, /PASS\s+Postgres connection/); assert.match(db.out, /SKIP\s+storage/); assert.match(db.out, /SKIP\s+Buffer/); assert.ok(!/bucket/.test(db.out.replace(/SKIP[^\n]*/g, '')));
    const st = run('staging-check.js', ['--selftest', '--only=storage'], { SELFTEST_BAD_BUFFER_KEY: '1' });
    assert.strictEqual(st.code, 0, st.out); assert.match(st.out, /PASS\s+signed upload link/); assert.match(st.out, /SKIP\s+Postgres/); assert.ok(!/PASS\s+Postgres connection/.test(st.out));
  });
  it('reports every temporary storage write and that all were deleted again', () => {
    const r = run('staging-check.js', ['--selftest', '--only=storage']);
    assert.match(r.out, /PASS\s+temporary storage objects\s+-\s+4 written and 4 deleted again \(all under staging-check\/\)/);
  });
  it('refuses to run against anything that is not staging (outside self-test)', () => {
    for (const script of ['staging-check.js', 'staging-e2e.js']) {
      const r = run(script, [], { DEPLOY_ENV: 'production', BUFFER_ENV: 'staging', DATABASE_URL: 'postgres://u@127.0.0.1/x', S3_BUCKET_PRIVATE: 'jnr-staging-private', S3_BUCKET_PUBLIC: 'jnr-staging-public' });
      assert.strictEqual(r.code, 2, script + ': ' + r.out); assert.match(r.out, /Refusing to run/);
    }
  });
  it('deletes the test draft BEFORE the photos, and says so', () => {
    const r = run('staging-e2e.js', ['--selftest']);
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /PASS\s+test draft deleted from Buffer and confirmed gone/); assert.match(r.out, /not test the deployed Vercel preview/); assert.match(r.out, /synthetic photographs only/i);
  });
  it('keeps the public photos and prints exact deletion steps if the draft cannot be deleted, so no draft points at deleted images', () => {
    const r = run('staging-e2e.js', ['--selftest'], { SELFTEST_DELETE_FAILS: '1' });
    assert.match(r.out, /WARN\s+the test draft could NOT be deleted automatically/); assert.match(r.out, /WARN\s+public photos KEPT/); assert.match(r.out, /TO FINISH CLEANING UP BY HAND/);
    assert.match(r.out, /delete the draft \(post id [a-f0-9]{24}\)/); assert.match(r.out, /public\/[0-9a-f-]{36}\//);
    assert.ok(!/PASS\s+test draft deleted/.test(r.out));
  });
});
