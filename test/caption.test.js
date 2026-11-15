'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const caption = require('../api/_lib/caption');

const entry = { kind: 'completed', title: 'Stainless steel flange set', summary: 'Batch of flanges turned and drilled.', material: '316 stainless steel', process: 'CNC turning', stage: null, customer_name: 'Acme Marine', job_ref: 'JOB-7742' };

describe('captions', () => {
  it('template captions use only the supplied facts, in plain UK English', () => {
    const f = caption.factsOf(entry);
    const t = caption.templateCaption(f);
    assert.match(t, /Completed: Stainless steel flange set\./);
    assert.match(t, /Material: 316 stainless steel\. Process: CNC turning\./);
    assert.match(t, /J\.N\.R\. Engineering, Hamilton\./);
    assert.ok(!/Acme|JOB-7742/.test(t));
    assert.deepStrictEqual(caption.validateCaption(t, f, [entry.customer_name, entry.job_ref]), { ok: true, problems: [] });
    assert.ok(t.length < 700 && !/!/.test(t));
  });
  it('in-production captions mention the stage, and never promise a finish', () => {
    const t = caption.templateCaption(caption.factsOf({ kind: 'in_production', title: 'Drive shafts', summary: 'First of the batch off the lathe', material: 'EN24', process: 'CNC turning', stage: 'machining' }));
    assert.match(t, /Current stage: On the machines\./);
    assert.ok(!/quote|deliver|complete/i.test(t));
  });
  it('rejects invented numbers, tolerances, certifications, lead times, customers and places', () => {
    const f = caption.factsOf(entry);
    const bad = [
      'Held to ±0.01mm across the batch.', 'We machined 40 flanges.', 'ISO 9001 certified work from Hamilton.',
      'Delivered in 3 days.', 'Another successful job for Acme Marine.', 'A guaranteed result, as always.', 'Made in Glasgow for the Navy.',
      'Quick turnaround with a short lead time.',
    ];
    bad.forEach((b) => assert.strictEqual(caption.validateCaption(b, f, [entry.customer_name]).ok, false, 'should reject: ' + b));
  });
  it('accepts a numbers or claim that is in the job facts themselves', () => {
    const f = caption.factsOf({ kind: 'completed', title: 'Batch of 25 shafts', summary: 'Turned from 40mm bar.', material: 'EN8', process: 'CNC turning' });
    assert.strictEqual(caption.validateCaption('Completed: Batch of 25 shafts. Turned from 40mm bar.', f).ok, true);
  });
  it('uses the template when AI captions are off (the default), even if a key exists', async () => {
    delete process.env.AI_CAPTIONS_ENABLED; process.env.ANTHROPIC_API_KEY = 'sk-test';
    const r = await caption.generateCaption(entry);
    assert.strictEqual(r.source, 'template');
  });
  describe('optional AI provider (fake service, no cost)', () => {
    let reply = ''; let calls = []; let status = 200;
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      calls.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: reply }] }));
    });
    let url;
    const ready = new Promise((r) => server.listen(0, '127.0.0.1', () => { url = 'http://127.0.0.1:' + server.address().port; r(); }));
    after(() => server.close());
    const on = () => { process.env.AI_CAPTIONS_ENABLED = 'true'; process.env.ANTHROPIC_API_KEY = 'sk-test'; process.env.ANTHROPIC_API_URL = url; };
    it('sends only the job facts and company background, never the customer or job reference', async () => {
      await ready; on(); calls = []; status = 200;
      reply = 'Stainless steel flanges, turned and drilled in our Hamilton workshop. Material: 316 stainless steel. #CNCTurning';
      const r = await caption.generateCaption(entry);
      assert.strictEqual(r.source, 'ai'); assert.strictEqual(calls.length, 1);
      const sent = JSON.stringify(calls[0].body);
      assert.ok(!/Acme|JOB-7742/.test(sent), 'private fields not sent');
      assert.match(sent, /Never name a customer/);
      assert.strictEqual(calls[0].headers['x-api-key'], 'sk-test');
    });
    it('falls back to the template when the AI caption invents something', async () => {
      await ready; on(); status = 200;
      reply = 'Flanges held to a tolerance of 0.02mm for a major oil company, delivered in 5 days.';
      const r = await caption.generateCaption(entry);
      assert.strictEqual(r.source, 'template'); assert.match(r.note, /rejected/);
      assert.ok(!/0\.02|oil/.test(r.caption));
    });
    it('falls back when the service is down or the key is missing', async () => {
      await ready; on(); status = 500;
      assert.strictEqual((await caption.generateCaption(entry)).source, 'template');
      status = 200; delete process.env.ANTHROPIC_API_KEY;
      const r = await caption.generateCaption(entry);
      assert.strictEqual(r.source, 'template'); assert.match(r.note, /no key/);
      delete process.env.AI_CAPTIONS_ENABLED;
    });
  });
});
