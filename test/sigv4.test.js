'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { presignPut, presignGet } = require('../api/_lib/s3');

// The worked example from the AWS Signature V4 documentation ("Authenticating Requests: Using Query Parameters").
// If our signer matches this, uploads will be accepted by real S3-compatible storage.
test('presigned GET matches the AWS documented example signature', () => {
  const cfg = { endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', pathStyle: false };
  const out = presignGet(cfg, 'examplebucket', 'test.txt', { expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
  assert.ok(out.url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?'));
  assert.match(out.url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('presigned PUT signs the content type and expiry, path-style for R2/Supabase', () => {
  const cfg = { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK', pathStyle: true };
  const out = presignPut(cfg, 'private-bucket', 'originals/a b/c.jpg', 'image/jpeg', { expires: 600, now: new Date('2026-01-01T00:00:00Z') });
  assert.strictEqual(out.method, 'PUT');
  assert.deepStrictEqual(out.headers, { 'content-type': 'image/jpeg' });
  assert.match(out.url, /^https:\/\/acct\.r2\.cloudflarestorage\.com\/private-bucket\/originals\/a%20b\/c\.jpg\?/);
  assert.match(out.url, /X-Amz-SignedHeaders=content-type%3Bhost/);
  assert.match(out.url, /X-Amz-Expires=600/);
  const other = presignPut(cfg, 'private-bucket', 'originals/a b/c.jpg', 'image/png', { expires: 600, now: new Date('2026-01-01T00:00:00Z') });
  assert.notStrictEqual(out.url, other.url, 'a different content type must produce a different signature');
});
