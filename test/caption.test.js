'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
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
});
