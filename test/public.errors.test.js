'use strict';
// What visitors get if the database is not configured or is down: the right content type, a 503, no caching, no internals.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

describe('public pages when the database is unavailable', () => {
  let server, origin; const saved = process.env.DATABASE_URL;
  before(async () => {
    delete process.env.DATABASE_URL;
    const pub = require('../api/public');
    server = http.createServer((req, res) => pub(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async () => { await new Promise((r) => server.close(r)); if (saved) process.env.DATABASE_URL = saved; });

  it('answers the feed in JSON, never HTML, and never caches the failure', async () => {
    const r = await fetch(origin + '/api/feed');
    assert.strictEqual(r.status, 503); assert.match(r.headers.get('content-type'), /application\/json/); assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await r.json(), { items: [], error: 'unavailable' });
  });
  it('answers the sitemap as an empty XML sitemap', async () => {
    const r = await fetch(origin + '/sitemap-work.xml');
    assert.strictEqual(r.status, 503); assert.match(r.headers.get('content-type'), /application\/xml/);
    const t = await r.text(); assert.match(t, /<urlset[^>]*><\/urlset>/); assert.ok(!/<loc>/.test(t));
  });
  it('shows a friendly page for Our Work and for a case study, with no error details', async () => {
    for (const p of ['/our-work', '/our-work/some-case-study']) {
      const r = await fetch(origin + p); const t = await r.text();
      assert.strictEqual(r.status, 503, p); assert.match(r.headers.get('content-type'), /text\/html/); assert.strictEqual(r.headers.get('cache-control'), 'no-store');
      assert.match(t, /having a problem/); assert.ok(!/DATABASE_URL|\bstack\b|Error:|node_modules|postgres/.test(t), 'no internals in ' + p);
    }
  });
  it('rejects anything but GET and HEAD', async () => {
    assert.strictEqual((await fetch(origin + '/our-work', { method: 'POST' })).status, 405);
  });
});
