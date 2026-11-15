'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { lint } = require('../scripts/lib/staging-env');
const { sslOptions } = require('../api/_lib/db');
const fs = require('node:fs');
const path = require('node:path');

const good = {
  DATABASE_URL: 'postgresql://u:p@ep-cool-123-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require',
  S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', S3_ACCESS_KEY_ID: 'a'.repeat(32), S3_SECRET_ACCESS_KEY: 'b'.repeat(64),
  S3_BUCKET_PRIVATE: 'jnr-staging-private', S3_BUCKET_PUBLIC: 'jnr-staging-public', DEPLOY_ENV: 'staging', PUBLIC_MEDIA_BASE_URL: 'https://pub-0123abcd.r2.dev',
  BUFFER_API_TOKEN: 'k9Qm2Vz7Lp4Tn8Rw1Ys6Hd3Jf5Bc0Xe'.repeat(2), BUFFER_ENV: 'staging', BUFFER_STAGING_CHANNEL_ID: '6afa05fbece6dfde5fd74165',
};

describe('staging environment lint', () => {
  it('accepts a correct Neon + R2 + Buffer set, warning only that r2.dev is for staging', () => {
    const r = lint(good); assert.deepStrictEqual(r.problems, []); assert.strictEqual(r.warnings.length, 1); assert.match(r.warnings[0], /r2\.dev/); assert.match(r.warnings[0], /synthetic or non-sensitive/);
  });
  it('flags every common mistake without echoing a value', () => {
    const bad = Object.assign({}, good, { DATABASE_URL: 'mysql://x', S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/jnr-private', S3_BUCKET_PUBLIC: 'jnr-staging-private',
      PUBLIC_MEDIA_BASE_URL: 'http://pub.r2.dev/', BUFFER_ENV: 'production', BUFFER_STAGING_CHANNEL_ID: 'abc', AI_CAPTIONS_ENABLED: 'true', TOLRA_ENABLED: '1', S3_SECRET_ACCESS_KEY: 'changeme' });
    const r = lint(bad); const all = r.problems.join(' | ');
    for (const re of [/postgres/, /must not include a bucket/, /two different buckets/, /https/, /trailing slash|end with a slash/, /staging/, /24-character/, /AI_CAPTIONS/, /TOLRA/, /placeholder/]) assert.match(all, re);
    assert.ok(!/changeme|mysql:\/\/x|abc/.test(JSON.stringify(r.warnings) + all.replace(/AI_CAPTIONS_ENABLED|TOLRA_ENABLED/g, '')), 'values are not echoed');
  });
  it('catches the private S3 endpoint used as the public media URL, and an unpooled Neon string', () => {
    assert.match(lint(Object.assign({}, good, { PUBLIC_MEDIA_BASE_URL: good.S3_ENDPOINT })).problems.join(' '), /PUBLIC address/);
    assert.match(lint(Object.assign({}, good, { DATABASE_URL: 'postgresql://u:p@ep-cool-123.eu-west-2.aws.neon.tech/neondb?sslmode=require' })).warnings.join(' '), /pooled/);
  });
  it('the example file lists every variable the lint checks, with no values filled in', () => {
    const ex = fs.readFileSync(path.join(__dirname, '..', '.env.staging.example'), 'utf8');
    for (const k of Object.keys(good)) assert.match(ex, new RegExp('^' + k + '=', 'm'), k);
    assert.ok(!/=\s*(sk-|[a-f0-9]{32,})/.test(ex.replace(/6afa05fbece6dfde5fd74165/, '')), 'no secrets in the example');
    assert.match(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8'), /^\.env\.staging$/m);
  });
  it('database TLS is verified for remote hosts, off only for local ones, and can be relaxed explicitly', () => {
    assert.strictEqual(sslOptions('postgres://u@127.0.0.1:5432/x', {}), false);
    assert.strictEqual(sslOptions('postgres://u@host/x?sslmode=disable', {}), false);
    assert.deepStrictEqual(sslOptions('postgres://u@ep.neon.tech/x?sslmode=require', {}), { rejectUnauthorized: true });
    assert.deepStrictEqual(sslOptions('postgres://u@ep.neon.tech/x', { DATABASE_SSL_VERIFY: 'false' }), { rejectUnauthorized: false });
  });
  it('the CORS file is valid, allows only PUT with content-type from the preview address', () => {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'r2-cors.json'), 'utf8'));
    assert.deepStrictEqual(c[0].AllowedMethods, ['PUT']); assert.deepStrictEqual(c[0].AllowedHeaders, ['content-type']);
    assert.deepStrictEqual(c[0].AllowedOrigins, ['https://jnr-git-feature-workshop-content-rhsys-projects.vercel.app']);
  });
});
