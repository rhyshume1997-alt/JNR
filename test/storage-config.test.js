'use strict';
// Photos need BOTH buckets and the public address (Buffer fetches the public copies): a missing or reused setting refuses to start, never half-works.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const GOOD = { S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_BUCKET_PRIVATE: 'jnr-prod-private', S3_BUCKET_PUBLIC: 'jnr-prod-public', PUBLIC_MEDIA_BASE_URL: 'https://media.example.com' };
describe('storage settings', () => {
  let saved;
  beforeEach(() => { saved = {}; for (const k of Object.keys(GOOD)) { saved[k] = process.env[k]; process.env[k] = GOOD[k]; } });
  afterEach(() => { for (const k of Object.keys(GOOD)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const use = () => require('../api/_lib/s3').storage.presignUpload('k.jpg', 'image/jpeg', 100);
  it('works with everything set', () => { assert.doesNotThrow(use); });
  for (const k of Object.keys(GOOD)) {
    it('refuses without ' + k, () => { delete process.env[k]; assert.throws(use, (e) => e.code === 'not_configured' && e.status === 503); });
  }
  it('refuses when the private and public bucket are the same one', () => {
    process.env.S3_BUCKET_PUBLIC = process.env.S3_BUCKET_PRIVATE;
    assert.throws(use, (e) => e.code === 'not_configured' && /two different buckets/.test(e.message));
  });
});
