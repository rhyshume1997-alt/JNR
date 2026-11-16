'use strict';
// Makes the staging scripts refuse to run against anything that is not explicitly staging, and shows what they will touch.
// These scripts never call Vercel (no project, environment-variable or deployment changes) and never read or write
// production settings. The only systems they talk to are the database, the two storage buckets and Buffer named below.

function isOn(v) { return /^(1|true|yes|on)$/i.test(String(v || '')); }

// Throws with a plain explanation if the environment is not clearly staging.
function assertStagingTarget(env) {
  const why = [];
  if (env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production') why.push('this looks like a production environment (VERCEL_ENV / NODE_ENV)');
  if (env.DEPLOY_ENV !== 'staging') why.push('DEPLOY_ENV is not "staging" (it must be set in .env.staging)');
  if (env.BUFFER_ENV !== 'staging') why.push('BUFFER_ENV is not "staging"');
  const db = String(env.DATABASE_URL || '');
  if (/(^|[\/@.\-_])(prod|production|live)([\/@.\-_:?]|$)/i.test(db.replace(/^[a-z]+:\/\/[^@]*@/i, ''))) why.push('the database address contains "prod"/"production"/"live"');
  ['S3_BUCKET_PRIVATE', 'S3_BUCKET_PUBLIC'].forEach((k) => {
    const b = String(env[k] || '');
    if (b && !/staging/i.test(b)) why.push(k + ' does not contain "staging" (name staging buckets jnr-staging-private and jnr-staging-public so they can never be confused with production)');
    if (/(^|[-_])(prod|production|live)([-_]|$)/i.test(b)) why.push(k + ' looks like a production bucket');
  });
  if (isOn(env.AI_CAPTIONS_ENABLED)) why.push('AI captions are enabled (a paid API)');
  if (why.length) { const e = new Error('Refusing to run: ' + why.join('; ') + '.'); e.code = 'not_staging'; throw e; }
}

// Removes anything identifying from text that is about to be printed: database host, user and password, the R2 account
// address, key ids, the Buffer token and channel, and the public media host. Applied to every line the staging scripts print,
// because logs of a GitHub Action in a public repository are public.
function scrub(text, env) {
  let t = String(text == null ? '' : text);
  const pairs = [];
  try { const u = new URL(env.DATABASE_URL); pairs.push([u.hostname, '<db-host>'], [decodeURIComponent(u.username), '<db-user>'], [decodeURIComponent(u.password), '<db-password>']); } catch (_) { /* not set */ }
  try { const u = new URL(env.S3_ENDPOINT); pairs.push([u.hostname, '<r2-endpoint>'], [u.hostname.split('.')[0], '<r2-account>']); } catch (_) { /* not set */ }
  try { pairs.push([new URL(env.PUBLIC_MEDIA_BASE_URL).hostname, '<public-media-host>']); } catch (_) { /* not set */ }
  pairs.push([env.S3_ACCESS_KEY_ID, '<s3-key-id>'], [env.S3_SECRET_ACCESS_KEY, '<s3-secret>'], [env.BUFFER_API_TOKEN, '<buffer-token>'], [env.BUFFER_STAGING_CHANNEL_ID, '<buffer-channel>']);
  pairs.filter((p) => p[0] && String(p[0]).length >= 4).sort((a, b) => String(b[0]).length - String(a[0]).length).forEach(([v, label]) => { t = t.split(String(v)).join(label); });
  return t.replace(/postgres(ql)?:\/\/[^\s'"]+/g, '<database-url>');
}

// Lines for a banner: where the script will read and write. No passwords, keys or tokens. In a GitHub Action, hosts and ids are
// shortened as well, because the log may be public.
function describeTargets(env) {
  const ci = env.GITHUB_ACTIONS === 'true';
  const mid = (v) => (!ci || !v || String(v).length < 12 ? v : String(v).slice(0, 4) + '…' + String(v).slice(-4));
  let dbHost = '(not set)', dbName = '';
  try { const u = new URL(env.DATABASE_URL); dbHost = mid(u.host); dbName = u.pathname.replace(/^\//, ''); } catch (_) { /* leave default */ }
  let media = '(not set)';
  try { media = mid(new URL(env.PUBLIC_MEDIA_BASE_URL).host); } catch (_) { /* leave default */ }
  return [
    'Database      ' + dbHost + (dbName ? '  /' + dbName : ''),
    'Private bucket  ' + (env.S3_BUCKET_PRIVATE || '(not set)'),
    'Public bucket   ' + (env.S3_BUCKET_PUBLIC || '(not set)') + '   (public address host: ' + media + ')',
    'Buffer       ' + (env.BUFFER_ENV || '?') + ' mode, channel ' + (mid(env.BUFFER_STAGING_CHANNEL_ID) || '(not set)') + ', key ' + (env.BUFFER_API_TOKEN ? 'present' : 'absent'),
    'Vercel       not contacted (these scripts never change any Vercel project, variable or deployment)',
  ];
}

module.exports = { assertStagingTarget, describeTargets, scrub };
