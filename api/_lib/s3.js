'use strict';

// Minimal S3-compatible client (AWS Signature V4) with no SDK. Works with Cloudflare R2, Supabase Storage (S3 protocol),
// Backblaze B2, MinIO and AWS S3. Used for: browser upload links (presigned PUT), server reads/writes/deletes.

const crypto = require('node:crypto');
const { getConfig } = require('./config');

const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function enc(s) { return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function encPath(p) { return p.split('/').map(enc).join('/'); }

function amzDate(now) { return (now || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, ''); }

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}

function canonicalQuery(params) {
  return Object.keys(params).sort().map((k) => enc(k) + '=' + enc(params[k])).join('&');
}

// Builds the object URL parts for a bucket and key.
function target(cfg, bucket, key) {
  const base = new URL(cfg.endpoint);
  if (cfg.pathStyle) return { host: base.host, path: '/' + encPath(bucket) + '/' + encPath(key), origin: base.origin };
  return { host: bucket + '.' + base.host, path: '/' + encPath(key), origin: base.protocol + '//' + bucket + '.' + base.host };
}

// Link a browser can use to PUT one file directly to storage, no server in the middle. Content-Type is signed,
// so the browser must send exactly the type that was approved.
function presignPut(cfg, bucket, key, contentType, opts) {
  const t = target(cfg, bucket, key);
  const now = (opts && opts.now) || new Date();
  const expires = (opts && opts.expires) || 600;
  return presign(cfg, 'PUT', t, expires, now, contentType ? { 'content-type': contentType } : {});
}

function presignGet(cfg, bucket, key, opts) {
  const t = target(cfg, bucket, key);
  return presign(cfg, 'GET', t, (opts && opts.expires) || 300, (opts && opts.now) || new Date(), {});
}

function presign(cfg, method, t, expires, now, extraHeaders) {
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const scope = day + '/' + cfg.region + '/s3/aws4_request';
  const headers = Object.assign({ host: t.host }, extraHeaders);
  const signedHeaders = Object.keys(headers).sort().join(';');
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': cfg.accessKeyId + '/' + scope,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalHeaders = Object.keys(headers).sort().map((k) => k + ':' + String(headers[k]).trim() + '\n').join('');
  const canonical = [method, t.path, canonicalQuery(params), canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(cfg.secretAccessKey, day, cfg.region, 's3')).update(toSign).digest('hex');
  return { url: t.origin + t.path + '?' + canonicalQuery(params) + '&X-Amz-Signature=' + signature, method, headers: extraHeaders };
}

// Server-side requests with an Authorization header.
async function request(cfg, method, bucket, key, body, extra) {
  const t = target(cfg, bucket, key);
  const now = (extra && extra.now) || new Date();
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const payloadHash = sha256hex(body || '');
  const headers = { host: t.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
  if (extra && extra.contentType) headers['content-type'] = extra.contentType;
  if (extra && extra.cacheControl) headers['cache-control'] = extra.cacheControl;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((k) => k + ':' + String(headers[k]).trim() + '\n').join('');
  const canonical = [method, t.path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = day + '/' + cfg.region + '/s3/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(cfg.secretAccessKey, day, cfg.region, 's3')).update(toSign).digest('hex');
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + cfg.accessKeyId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  delete headers.host;
  const res = await fetch(t.origin + t.path, { method, headers, body: body || undefined, signal: AbortSignal.timeout(20000) });
  return res;
}

function storageCfg() {
  const c = getConfig().storage;
  if (!c.endpoint || !c.accessKeyId || !c.secretAccessKey || !c.privateBucket || !c.publicBucket || !c.publicBaseUrl) {
    const e = new Error('Image storage is not configured (S3_* and PUBLIC_MEDIA_BASE_URL).');
    e.status = 503; e.code = 'not_configured';
    throw e;
  }
  return c;
}

const storage = {
  presignUpload(key, contentType) { const c = storageCfg(); return presignPut(c, c.privateBucket, key, contentType, { expires: getConfig().upload.presignSeconds }); },
  async head(bucketName, key) {
    const c = storageCfg();
    const res = await request(c, 'HEAD', c[bucketName], key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Storage HEAD failed: ' + res.status);
    return { bytes: Number(res.headers.get('content-length') || 0), contentType: res.headers.get('content-type') };
  },
  async get(bucketName, key, maxBytes) {
    const c = storageCfg();
    const res = await request(c, 'GET', c[bucketName], key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Storage GET failed: ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buf.length > maxBytes) throw new Error('Stored object is larger than allowed.');
    return buf;
  },
  async put(bucketName, key, buffer, contentType, cacheControl) {
    const c = storageCfg();
    const res = await request(c, 'PUT', c[bucketName], key, buffer, { contentType, cacheControl });
    if (!res.ok) throw new Error('Storage PUT failed: ' + res.status);
  },
  async del(bucketName, key) {
    const c = storageCfg();
    const res = await request(c, 'DELETE', c[bucketName], key);
    if (!res.ok && res.status !== 404) throw new Error('Storage DELETE failed: ' + res.status);
  },
  publicUrl(key) { return storageCfg().publicBaseUrl + '/' + encPath(key); },
};

module.exports = { storage, presignPut, presignGet, request, target, signingKey, sha256hex, canonicalQuery, amzDate };
