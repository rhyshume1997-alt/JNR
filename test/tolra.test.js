'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const tolra = require('../api/_lib/tolra');

describe('Tolra read-only adapter', () => {
  let reply = { status: 'Machining', customer: 'LEAK', price: 999, drawing: 'LEAK.pdf' }; let seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, method: req.method, auth: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); });
  const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  it('is off by default and does nothing', async () => {
    delete process.env.TOLRA_ENABLED;
    assert.strictEqual(await tolra.suggestStage('J-1001'), null); assert.strictEqual(seen.length, 0);
  });
  it('asks only for a stage by job reference, and drops every other field', async () => {
    await ready;
    Object.assign(process.env, { TOLRA_ENABLED: 'true', TOLRA_READ_URL: 'http://127.0.0.1:' + server.address().port, TOLRA_READ_TOKEN: 'read-only-token' });
    const r = await tolra.suggestStage('J-1001');
    assert.deepStrictEqual(r, { stage: 'machining' });
    assert.deepStrictEqual(seen[0], { url: '/jobs/J-1001/stage', method: 'GET', auth: 'Bearer read-only-token' });
  });
  it('ignores unknown statuses instead of guessing, and rejects odd job references', async () => {
    reply = { status: 'Awaiting customer sign-off' };
    assert.strictEqual(await tolra.suggestStage('J-1001'), null);
    const n = seen.length;
    assert.strictEqual(await tolra.suggestStage('../../etc/passwd'), null); assert.strictEqual(seen.length, n);
  });
  it('never throws when Tolra is down', async () => {
    process.env.TOLRA_READ_URL = 'http://127.0.0.1:1';
    assert.strictEqual(await tolra.suggestStage('J-1001'), null);
    delete process.env.TOLRA_ENABLED;
  });
});
