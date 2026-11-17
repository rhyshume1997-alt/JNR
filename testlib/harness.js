'use strict';
// Shared test fixtures. Nothing here talks to the internet: storage, Buffer and the caption service are local fakes,
// and the database is a throw-away Postgres database created per test file.
// Set TEST_DATABASE_URL to a Postgres server URL (any database name) to run the database tests, for example
//   TEST_DATABASE_URL=postgres://user@localhost:5432/postgres npm test
// Without it, database tests are skipped and say so.

const http = require('node:http');
const crypto = require('node:crypto');
const { Client } = require('pg');
const sharp = require('sharp');

const BASE = process.env.TEST_DATABASE_URL;

async function createTestDb() {
  const admin = new Client({ connectionString: BASE });
  await admin.connect();
  const name = 'jnr_test_' + crypto.randomBytes(5).toString('hex');
  await admin.query('create database ' + name);
  await admin.end();
  const u = new URL(BASE);
  u.pathname = '/' + name;
  const url = u.toString();
  process.env.DATABASE_URL = url;
  const { migrate } = require('../scripts/migrate');
  await migrate();
  return {
    url, name,
    async drop() {
      await require('../api/_lib/db').closePool();
      const a = new Client({ connectionString: BASE }); await a.connect();
      await a.query('drop database if exists ' + name + ' with (force)'); await a.end();
    },
  };
}

// ---- fake S3: verifies SigV4 independently of api/_lib/s3.js (own canonicalisation code).
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function expectedSignature(secret, region, method, path, query, headers, signedHeaders, payload, date) {
  const cq = Object.keys(query).sort().map((k) => enc(k) + '=' + enc(query[k])).join('&');
  const ch = signedHeaders.split(';').map((h) => h + ':' + String(headers[h]).trim() + '\n').join('');
  const canonical = [method, path, cq, ch, signedHeaders, payload].join('\n');
  const day = date.slice(0, 8);
  const scope = day + '/' + region + '/s3/aws4_request';
  const sts = ['AWS4-HMAC-SHA256', date, scope, hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
  return crypto.createHmac('sha256', key).update(sts).digest('hex');
}

async function startFakeS3(opts) {
  const o = Object.assign({ accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET', region: 'auto' }, opts);
  const objects = new Map();
  const log = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,HEAD,DELETE');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const entry = { method: req.method, path };
    const deny = (code, msg) => { entry.denied = msg; log.push(entry); res.writeHead(code); res.end(msg); };
    let ok = false;
    if (u.searchParams.get('X-Amz-Signature')) {
      const q = {}; u.searchParams.forEach((v, k) => { if (k !== 'X-Amz-Signature') q[k] = v; });
      const exp = Date.parse(q['X-Amz-Date'].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) + Number(q['X-Amz-Expires']) * 1000;
      if (Date.now() > exp) return deny(403, 'expired');
      const headers = {}; q['X-Amz-SignedHeaders'].split(';').forEach((h) => { headers[h] = req.headers[h]; });
      const sig = expectedSignature(o.secretAccessKey, o.region, req.method, path, q, headers, q['X-Amz-SignedHeaders'], 'UNSIGNED-PAYLOAD', q['X-Amz-Date']);
      ok = sig === u.searchParams.get('X-Amz-Signature');
      if (!ok) return deny(403, 'SignatureDoesNotMatch (presigned)');
      entry.presigned = true;
    } else if (req.headers.authorization) {
      const m = /SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(req.headers.authorization);
      const headers = {}; m[1].split(';').forEach((h) => { headers[h] = req.headers[h]; });
      if (req.headers['x-amz-content-sha256'] !== hex(body)) return deny(400, 'payload hash mismatch');
      const sig = expectedSignature(o.secretAccessKey, o.region, req.method, path, {}, headers, m[1], req.headers['x-amz-content-sha256'], req.headers['x-amz-date']);
      if (sig !== m[2]) return deny(403, 'SignatureDoesNotMatch');
    } else if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/public-media/')) { /* public bucket: anonymous reads allowed */ }
    else return deny(403, 'unsigned');
    log.push(entry);
    if (req.method === 'PUT') { objects.set(path, { body, type: req.headers['content-type'], cache: req.headers['cache-control'] }); res.writeHead(200); return res.end(); }
    const obj = objects.get(path);
    if (req.method === 'DELETE') { objects.delete(path); res.writeHead(204); return res.end(); }
    if (!obj) { res.writeHead(404); return res.end(); }
    res.writeHead(200, Object.assign({ 'content-length': obj.body.length, 'content-type': obj.type || 'application/octet-stream' }, obj.cache ? { 'cache-control': obj.cache } : {}));
    res.end(req.method === 'HEAD' ? undefined : obj.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  return { endpoint, objects, log, close: () => new Promise((r) => server.close(r)), opts: o };
}

// ---- fake Buffer GraphQL API. `behaviour` can be changed between calls.
async function startFakeBuffer() {
  const state = { posts: new Map(), calls: [], mode: 'ok', failures: 0, mutate: null, token: 'good-token' };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    state.calls.push({ query: body.query, variables: body.variables, auth: req.headers.authorization });
    const reply = (status, json, headers) => { res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers)); res.end(JSON.stringify(json)); };
    // Like the real API (see Buffer's error-handling guide): HTTP 200 with a coded error.
    if (req.headers.authorization !== 'Bearer ' + state.token) return reply(200, { data: null, errors: [{ message: 'Not authorized', extensions: { code: 'UNAUTHORIZED' } }] });
    const isCreate = /createPost/.test(body.query);
    if (state.failures > 0 && state.mode !== 'ok') {
      state.failures--;
      if (state.mode === '429') return reply(429, {}, { 'retry-after': '0' });
      if (state.mode === '503-before') return reply(503, {});
      if (state.mode === 'gql-rate-limit') return reply(200, { data: null, errors: [{ message: 'Too many requests', extensions: { code: 'RATE_LIMIT_EXCEEDED' } }] });
      if (state.mode === 'gql-unexpected-after' && isCreate) { storePost(body.variables.input); return reply(200, { data: null, errors: [{ message: 'Something went wrong', extensions: { code: 'UNEXPECTED' } }] }); }
      if (state.mode === '503-after' && isCreate) { storePost(body.variables.input); return reply(503, {}); }
      if (state.mode === 'reset-after' && isCreate) { storePost(body.variables.input); return req.socket.destroy(); }
    }
    function storePost(input) {
      const id = crypto.randomBytes(12).toString('hex');
      const p = { id, text: input.text, status: input.saveToDraft ? 'draft' : 'scheduled', channelId: input.channelId, dueAt: input.dueAt || null, sentAt: null,
        assets: (input.assets || []).map((a) => ({ __typename: 'ImageAsset', type: 'image', mimeType: 'image/jpeg', source: a.image.url, thumbnail: a.image.url })) };
      if (state.mutate) state.mutate(p);
      state.posts.set(id, p); return p;
    }
    if (isCreate) {
      const input = body.variables.input;
      if (state.mode === 'mutation-error') return reply(200, { data: { createPost: { __typename: 'MutationError', message: 'Channel is disconnected' } } });
      if (state.mode === 'graphql-error') return reply(200, { errors: [{ message: 'Field "foo" is not defined' }] });
      const p = storePost(input);
      return reply(200, { data: { createPost: { __typename: 'PostActionSuccess', post: p } } });
    }
    if (/deletePost/.test(body.query)) {
      const id = body.variables.input.id;
      if (state.deleteMode === 'error') return reply(200, { data: { deletePost: { __typename: 'VoidMutationError', message: 'Cannot delete right now' } } });
      if (state.deleteMode === 'noop') return reply(200, { data: { deletePost: { __typename: 'DeletePostSuccess', id } } }); // says deleted, is not
      state.posts.delete(id); state.deletes = (state.deletes || 0) + 1;
      return reply(200, { data: { deletePost: { __typename: 'DeletePostSuccess', id } } });
    }
    if (/ReadPost|post\(/.test(body.query)) {
      const p = state.posts.get(body.variables.input.id);
      if (!p) return reply(200, { data: null, errors: [{ message: 'Post not found', extensions: { code: 'NOT_FOUND' } }] });
      return reply(200, { data: { post: p } });
    }
    if (/account\s*\{/.test(body.query)) return reply(200, { data: { account: { id: 'acct1', organizations: [{ id: 'o'.repeat(24), name: 'Fake org' }] } } });
    if (/channels\(/.test(body.query)) return reply(200, { data: { channels: [{ id: process.env.BUFFER_STAGING_CHANNEL_ID, name: 'fake-profile', service: 'linkedin', type: 'profile', isDisconnected: false, isLocked: false }] } });
    if (/__type/.test(body.query)) return reply(200, { data: { __type: { name: 'CreatePostInput', kind: 'INPUT_OBJECT', inputFields: ['channelId', 'text', 'saveToDraft', 'assets', 'schedulingType', 'mode', 'dueAt'].map((name) => ({ name })) } } });
    reply(200, { data: {} });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + server.address().port, state, close: () => new Promise((r) => server.close(r)) };
}

// ---- the app: the real handlers behind a local server, routed the way vercel.json routes them.
async function startApp() {
  const admin = require('../api/admin');
  const pub = require('../api/public');
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/admin')) return admin(req, res);
    return pub(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  function client() {
    let cookie = '';
    const c = {
      origin,
      async call(method, path, body, extraHeaders) {
        const res = await fetch(origin + path, {
          method,
          headers: Object.assign({ cookie, origin, 'x-requested-with': 'jnr', 'content-type': 'application/json' }, extraHeaders || {}),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
        const type = res.headers.get('content-type') || '';
        const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
        return { status: res.status, data, headers: res.headers };
      },
      get: (p) => c.call('GET', '/api/admin' + p),
      post: (p, b, h) => c.call('POST', '/api/admin' + p, b === undefined ? {} : b, h),
      patch: (p, b) => c.call('PATCH', '/api/admin' + p, b),
      put: (p, b) => c.call('PUT', '/api/admin' + p, b),
      del: (p) => c.call('DELETE', '/api/admin' + p),
      async login(email, password) { return c.post('/auth/login', { email, password }); },
      get cookie() { return cookie; },
    };
    return c;
  }
  return { origin, client, close: () => new Promise((r) => server.close(r)) };
}

// ---- image fixtures
async function jpegWithExif(w, h, color) {
  return sharp({ create: { width: w || 1200, height: h || 800, channels: 3, background: color || '#446688' } })
    .withExif({ IFD0: { Copyright: 'SECRET-OWNER', Make: 'SECRETCAM' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '55/1 46/1 0/1' } }).jpeg().toBuffer();
}
async function pngImage(w, h) { return sharp({ create: { width: w || 600, height: h || 400, channels: 4, background: { r: 10, g: 80, b: 160, alpha: 0.5 } } }).png().toBuffer(); }
const FAKE_PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const FAKE_DXF = Buffer.from('  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1027\n  0\nENDSEC\n  0\nEOF\n');

// Environment for an isolated test run.
function setEnv(s3, buf) {
  Object.assign(process.env, {
    ALLOW_INSECURE_COOKIES: '1', SITE_URL: 'https://jnrengineering.co.uk',
    S3_ENDPOINT: s3.endpoint, S3_REGION: s3.opts.region, S3_ACCESS_KEY_ID: s3.opts.accessKeyId, S3_SECRET_ACCESS_KEY: s3.opts.secretAccessKey,
    S3_BUCKET_PRIVATE: 'private-originals', S3_BUCKET_PUBLIC: 'public-media', PUBLIC_MEDIA_BASE_URL: 'https://media.example.test',
    BUFFER_API_URL: buf ? buf.url : 'http://127.0.0.1:9', BUFFER_API_TOKEN: 'good-token', BUFFER_ENV: 'staging',
    BUFFER_STAGING_CHANNEL_ID: 'a'.repeat(24), BUFFER_CHANNEL_ID_LINKEDIN: 'b'.repeat(24), BUFFER_RETRY_DELAYS_MS: '1,1', BUFFER_TIMEOUT_MS: '2000',
    AI_CAPTIONS_ENABLED: '', TOLRA_ENABLED: '', DEPLOY_ENV: 'staging',
  });
}

// Uploads one image through the real API flow (presign -> PUT to fake storage -> finalize).
async function uploadImage(api, entryId, buf, type, name) {
  const p = await api.post('/entries/' + entryId + '/images/presign', { name: name || 'photo.jpg', type: type || 'image/jpeg', size: buf.length });
  if (p.status !== 201) return { presign: p };
  const put = await fetch(p.data.upload.url, { method: 'PUT', headers: p.data.upload.headers, body: buf });
  const fin = await api.post('/images/' + p.data.image_id + '/finalize');
  return { presign: p, put, finalize: fin, imageId: p.data.image_id };
}

// ---- fake Anthropic Messages API for the AI caption tests. `state.reply` is the text returned; `state.mode` can make it fail.
async function startFakeAnthropic() {
  const state = { reply: '{"post": "", "questions": []}', replies: [], status: 200, delayMs: 0, calls: [], usage: { input_tokens: 1200, output_tokens: 90 }, stopReason: 'end_turn' };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { /* leave empty */ }
    state.calls.push({ headers: req.headers, body, raw: Buffer.concat(chunks).toString() });
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    res.writeHead(state.status, { 'content-type': 'application/json' });
    const text = state.replies.length ? state.replies.shift() : state.reply;
    res.end(JSON.stringify(state.status === 200 ? { content: (state.rawQueue && state.rawQueue.length ? state.rawQueue.shift() : state.rawContent) || [{ type: 'text', text }], usage: state.usage, stop_reason: state.stopReason } : { error: { message: 'nope' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + server.address().port + '/v1/messages', state, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { startFakeAnthropic, BASE, createTestDb, startFakeS3, startFakeBuffer, startApp, jpegWithExif, pngImage, FAKE_PDF, FAKE_DXF, setEnv, uploadImage, expectedSignature };
