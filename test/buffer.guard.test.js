'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const B = require('../api/_lib/buffer');

const ch = 'a'.repeat(24);
describe('Buffer draft-only guard', () => {
  it('builds inputs that always save a draft and never schedule', () => {
    const i = B.draftInput({ channelId: ch, text: 'Hi', imageUrls: ['https://m/x.jpg'], altTexts: ['alt'] });
    assert.strictEqual(i.saveToDraft, true); assert.strictEqual(i.dueAt, undefined);
    assert.deepStrictEqual(i.assets, [{ image: { url: 'https://m/x.jpg', metadata: { altText: 'alt' } } }]);
  });
  it('refuses anything that could publish or schedule', () => {
    const ok = { channelId: ch, text: 'x', saveToDraft: true };
    assert.doesNotThrow(() => B.assertDraftOnly(ok));
    [{ saveToDraft: false }, { saveToDraft: undefined }, { mode: 'shareNow' }, { mode: 'shareNext' }, { mode: 'customScheduled' }, { dueAt: '2027-01-01T09:00:00Z' }, { channelId: 'nope' }]
      .forEach((bad) => assert.throws(() => B.assertDraftOnly(Object.assign({}, ok, bad)), /Refusing/, JSON.stringify(bad)));
  });
  it('createDraft refuses before any network call', async () => {
    await assert.rejects(() => B.createDraft({ channelId: ch, text: 'x', saveToDraft: false }), /saveToDraft/);
  });
  it('verifies caption, status, schedule and images exactly', () => {
    const want = { channelId: ch, text: 'Line one\nLine two', imageUrls: ['https://m/1.jpg', 'https://m/2.jpg'] };
    const good = { status: 'draft', dueAt: null, sentAt: null, channelId: ch, text: 'Line one\r\nLine two', assets: [{ type: 'image', source: 'https://m/1.jpg' }, { type: 'image', source: 'https://m/2.jpg' }] };
    assert.strictEqual(B.verifyDraft(good, want).ok, true);
    const cases = [
      [{ status: 'scheduled' }, /status/], [{ dueAt: '2027-01-01' }, /scheduled time/], [{ sentAt: '2027-01-01' }, /sent/], [{ text: 'Different' }, /caption differs/],
      [{ channelId: 'b'.repeat(24) }, /different channel/], [{ assets: [] }, /0 image/], [{ assets: [good.assets[1], good.assets[0]] }, /Image 1/],
    ];
    cases.forEach(([patch, re]) => { const v = B.verifyDraft(Object.assign({}, good, patch), want); assert.strictEqual(v.ok, false); assert.match(v.problems.join(' '), re); });
  });
});
