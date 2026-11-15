'use strict';
// Read-only health check for a staging setup: Postgres, Cloudflare R2 (or any S3-compatible store) and Buffer.
// Prints PASS / FAIL / WARN per check and never prints a secret. It writes two tiny throw-away objects to storage and
// deletes them. It does NOT create any Buffer post.
//
//   Set the same environment variables the site uses (see .env.example), then:  npm run staging:check
//   Optional: STAGING_ORIGIN=https://your-preview-host   also checks that browser uploads from that origin are allowed (CORS)
//   --selftest runs the checks against local fakes, to prove the script itself works.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const lines = []; let failures = 0;
const say = (tag, name, detail) => { if (tag === 'FAIL') failures++; lines.push((tag + '    ').slice(0, 5) + ' ' + name + (detail ? '  -  ' + detail : '')); console.log(lines[lines.length - 1]); };
const pass = (n, d) => say('PASS', n, d); const fail = (n, d) => say('FAIL', n, d); const warn = (n, d) => say('WARN', n, d);

async function checkConfig() {
  const { getConfig } = require('../api/_lib/config');
  if (!process.argv.includes('--selftest')) {
    const l = require('./lib/staging-env').lint(process.env);
    l.problems.forEach((m) => fail('environment', m)); l.warnings.forEach((m) => warn('environment', m));
    if (!l.problems.length) pass('environment format', 'names present, formats look right');
  }
  const c = getConfig();
  const need = { DATABASE_URL: c.databaseUrl, S3_ENDPOINT: c.storage.endpoint, S3_ACCESS_KEY_ID: c.storage.accessKeyId, S3_SECRET_ACCESS_KEY: c.storage.secretAccessKey, S3_BUCKET_PRIVATE: c.storage.privateBucket,
    S3_BUCKET_PUBLIC: c.storage.publicBucket, PUBLIC_MEDIA_BASE_URL: c.storage.publicBaseUrl, BUFFER_API_TOKEN: c.buffer.token };
  const missing = Object.keys(need).filter((k) => !need[k]);
  missing.length ? fail('configuration', 'missing: ' + missing.join(', ')) : pass('configuration', 'all required names are set');
  if (c.storage.privateBucket && c.storage.privateBucket === c.storage.publicBucket) fail('buckets', 'the private and public bucket must be different');
  if (c.storage.publicBaseUrl && !/^https:\/\//.test(c.storage.publicBaseUrl) && !process.argv.includes('--selftest')) fail('public media URL', 'must be https (Buffer fetches it)');
  if (process.env.ALLOW_INSECURE_COOKIES && process.env.VERCEL) warn('cookies', 'ALLOW_INSECURE_COOKIES is set on Vercel; it is ignored there, but remove it');
  if (c.caption.aiEnabled) warn('AI captions', 'AI_CAPTIONS_ENABLED is on. This calls a paid API.');
  if (c.tolra.enabled) warn('Tolra', 'TOLRA_ENABLED is on');
  c.buffer.env === 'staging' ? pass('Buffer mode', 'staging: only BUFFER_STAGING_CHANNEL_ID can be used') : warn('Buffer mode', 'PRODUCTION: drafts will go to BUFFER_CHANNEL_ID_LINKEDIN');
  if (c.buffer.env === 'staging' && !c.buffer.stagingChannelId) fail('Buffer channel', 'BUFFER_STAGING_CHANNEL_ID is not set');
  return c;
}

async function checkDatabase() {
  const { query } = require('../api/_lib/db');
  try {
    const v = (await query('select version() as v')).rows[0].v; pass('Postgres connection', v.split(' ').slice(0, 2).join(' '));
    const applied = new Set((await query('select name from schema_migrations').catch(() => ({ rows: [] }))).rows.map((r) => r.name));
    const files = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((f) => f.endsWith('.sql'));
    const todo = files.filter((f) => !applied.has(f));
    todo.length ? fail('migrations', 'not applied: ' + todo.join(', ') + '  (run: npm run migrate)') : pass('migrations', files.length + ' applied');
    const t = (await query("select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")).rows;
    const noRls = t.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    noRls.length ? fail('row level security', 'off for: ' + noRls.join(', ')) : pass('row level security', 'on for all ' + t.length + ' tables');
    const roles = (await query("select r.rolname from pg_roles r where r.rolname in ('anon','authenticated')")).rows.map((r) => r.rolname);
    for (const role of roles) {
      const g = (await query("select count(*)::int n from information_schema.role_table_grants where grantee = $1 and table_schema = 'public' and table_name in ('users','sessions','entries','entry_images','publications','audit_log')", [role])).rows[0].n;
      g ? fail('API role ' + role, 'still has ' + g + ' table grants') : pass('API role ' + role, 'no access to application tables');
    }
    const admins = (await query("select count(*)::int n from users where role = 'admin' and not disabled")).rows[0].n;
    admins ? pass('admin user', admins + ' active') : warn('admin user', 'none yet (node scripts/create-user.js admin ...)');
  } catch (e) { fail('Postgres', e.message.replace(/postgres(ql)?:\/\/[^\s]+/g, '<url>')); }
}

async function checkStorage(c, base) {
  const { storage, presignPut } = require('../api/_lib/s3');
  const id = crypto.randomBytes(6).toString('hex');
  const jpg = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#335577' } }).jpeg().toBuffer();
  const priv = 'staging-check/' + id + '.jpg', pub = 'staging-check/' + id + '.jpg';
  const cfg = c.storage;
  try {
    await storage.put('privateBucket', priv, jpg, 'image/jpeg');
    const head = await storage.head('privateBucket', priv);
    const got = await storage.get('privateBucket', priv, 1e6);
    head && got && got.equals(jpg) ? pass('private bucket round trip', 'write, head, read OK') : fail('private bucket round trip', 'read back differs');
    // The private bucket must not be readable without credentials.
    const privUrl = cfg.pathStyle ? new URL(cfg.endpoint).origin + '/' + cfg.privateBucket + '/' + priv : new URL(cfg.endpoint).protocol + '//' + cfg.privateBucket + '.' + new URL(cfg.endpoint).host + '/' + priv;
    const anon = await fetch(privUrl, { redirect: 'manual' });
    anon.status === 200 ? fail('private bucket is private', 'anonymous GET returned the file! Turn public access OFF for this bucket') : pass('private bucket is private', 'anonymous GET -> ' + anon.status);

    // Signed browser upload: right size accepted, wrong size refused.
    const key = 'staging-check/up-' + id + '.jpg';
    const link = presignPut(cfg, cfg.privateBucket, key, 'image/jpeg', { expires: 120, contentLength: jpg.length });
    const okPut = await fetch(link.url, { method: 'PUT', headers: link.headers, body: jpg });
    okPut.ok ? pass('signed upload link', 'PUT accepted (' + okPut.status + ')') : fail('signed upload link', 'PUT refused (' + okPut.status + '). If this says SignatureDoesNotMatch, set S3_SIGN_CONTENT_LENGTH=false and re-run');
    if (okPut.ok) {
      const bad = presignPut(cfg, cfg.privateBucket, key + '.big', 'image/jpeg', { expires: 120, contentLength: jpg.length });
      const bigPut = await fetch(bad.url, { method: 'PUT', headers: bad.headers, body: Buffer.concat([jpg, Buffer.alloc(2048)]) });
      bigPut.ok ? warn('signed upload size limit', 'a larger file was accepted: storage does not enforce signed content-length; the server still rejects oversize files when it checks them') : pass('signed upload size limit', 'larger file refused (' + bigPut.status + ')');
      await storage.del('privateBucket', key + '.big').catch(() => {});
    }
    await storage.del('privateBucket', key).catch(() => {});

    // Browser uploads come from another origin: the bucket must allow it.
    const origin = process.env.STAGING_ORIGIN || c.siteUrl;
    const pf = await fetch(link.url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    const allow = pf.headers.get('access-control-allow-origin');
    allow && (allow === '*' || allow === origin) && pf.status < 300 ? pass('browser upload CORS', 'allowed from ' + origin) : fail('browser upload CORS', 'preflight from ' + origin + ' -> ' + pf.status + ' allow-origin=' + allow + '. Add the CORS rule from docs/WORKSHOP-SETUP.md to the PRIVATE bucket');

    // Public bucket: what Buffer will fetch.
    await storage.put('publicBucket', pub, jpg, 'image/jpeg', 'public, max-age=31536000, immutable');
    const url = storage.publicUrl(pub);
    const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; media-check)' } });
    const type = r.headers.get('content-type') || '';
    r.status === 200 && /^image\/jpeg/.test(type) ? pass('public image URL', 'anonymous GET 200 ' + type) : fail('public image URL', 'anonymous GET -> ' + r.status + ' ' + type + (r.status >= 300 && r.status < 400 ? ' (a redirect: Buffer needs a direct URL)' : ''));
    if (!/^https:\/\//.test(url) && !base.selftest) fail('public image URL', 'not https');
    (r.headers.get('cache-control') || '').includes('immutable') ? pass('public image caching', 'immutable') : warn('public image caching', 'no immutable cache header on the public copy');
    const bot = await fetch(url, { headers: { 'user-agent': 'python-requests/2.31' } });
    bot.status === 200 ? pass('public URL for automated fetchers', 'not blocked') : fail('public URL for automated fetchers', 'status ' + bot.status + '. Buffer fetches media itself: turn off bot challenges / WAF rules for this media domain');
    await storage.del('publicBucket', pub).catch(() => {});
  } catch (e) { fail('storage', e.message); }
}

async function checkBuffer(c) {
  const B = require('../api/_lib/buffer');
  try {
    const acct = await B.gql('query { account { id organizations { id name } } }');
    pass('Buffer API key', 'accepted (' + acct.account.organizations.length + ' organization(s))');
    let found = null;
    for (const o of acct.account.organizations) {
      const ch = await B.listChannels(o.id);
      found = found || ch.find((x) => x.id === c.buffer.stagingChannelId);
      if (found) { pass('staging channel', found.service + ' "' + found.name + '" in "' + o.name + '"' + (found.isDisconnected || found.isLocked ? '' : ' - connected')); if (found.service !== 'linkedin') fail('staging channel', 'not a LinkedIn channel'); if (found.isDisconnected || found.isLocked) fail('staging channel', 'disconnected or locked'); }
    }
    if (!found && c.buffer.stagingChannelId) fail('staging channel', 'BUFFER_STAGING_CHANNEL_ID was not found in your Buffer account');
    const t = await B.gql('query T($n: String!) { __type(name: $n) { inputFields { name } } }', { n: 'CreatePostInput' });
    const have = (t.__type && t.__type.inputFields || []).map((f) => f.name);
    const want = ['channelId', 'text', 'saveToDraft', 'assets', 'schedulingType', 'mode'];
    const miss = want.filter((w) => !have.includes(w));
    miss.length ? fail('Buffer schema', 'CreatePostInput is missing ' + miss.join(', ')) : pass('Buffer schema', 'CreatePostInput has saveToDraft, assets, schedulingType, mode');
  } catch (e) { fail('Buffer', (e.message || String(e)).slice(0, 200)); }
}

async function main() {
  const self = process.argv.includes('--selftest'); let cleanup = async () => {};
  if (self) {
    const H = require('../testlib/harness');
    const db = await H.createTestDb(); const s3 = await H.startFakeS3(); const buf = await H.startFakeBuffer(); H.setEnv(s3, buf); process.env.PUBLIC_MEDIA_BASE_URL = s3.endpoint + '/public-media';
    const { Client } = require('pg'); // fake Buffer answers the account queries below
    buf.state.account = true; cleanup = async () => { await s3.close(); await buf.close(); await db.drop(); };
  }
  console.log('Staging check' + (self ? ' (self-test against local fakes)' : '') + '\n');
  const c = await checkConfig();
  await checkDatabase();
  await checkStorage(c, { selftest: self });
  await checkBuffer(c);
  console.log('\n' + (failures ? failures + ' check(s) FAILED. Fix them before using this environment.' : 'All checks passed.'));
  await require('../api/_lib/db').closePool(); await cleanup();
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
