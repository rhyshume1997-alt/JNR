'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const B = require('../api/_lib/buffer');

const ch = 'a'.repeat(24);
describe('Buffer error handling (documented and observed codes)', () => {
  const err = (code) => B.fromGraphqlError([{ message: 'm', extensions: { code } }]);
  it('maps each code to what is safe to do next', () => {
    assert.strictEqual(err('UNAUTHORIZED').kind, 'permanent');
    assert.strictEqual(err('UNAUTHENTICATED').kind, 'permanent', 'observed on the live API for a bad key');
    assert.strictEqual(err('FORBIDDEN').kind, 'permanent');
    assert.strictEqual(err('NOT_FOUND').kind, 'permanent');
    assert.strictEqual(err('RATE_LIMIT_EXCEEDED').kind, 'safe');
    assert.strictEqual(err('UNEXPECTED').kind, 'ambiguous');
    assert.strictEqual(err('SOMETHING_NEW').kind, 'permanent');
    assert.strictEqual(B.fromGraphqlError([{ message: 'Cannot query field x' }]).kind, 'permanent');
  });
});

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

describe('Buffer scheduled-post guard (opt-in path)', () => {
  const at = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  it('builds customScheduled inputs with a UTC time, never a draft flag, queue or post-now', () => {
    const i = B.scheduleInput({ channelId: ch, text: 'Hi', imageUrls: ['https://m/x.jpg'], altTexts: ['alt'], dueAt: at(24) });
    assert.strictEqual(i.mode, 'customScheduled'); assert.strictEqual(i.saveToDraft, false); assert.ok(/Z$/.test(i.dueAt));
  });
  it('refuses anything that could post straight away or is not a future UTC time', () => {
    const ok = { channelId: ch, text: 'x', saveToDraft: false, mode: 'customScheduled', dueAt: at(24) };
    assert.doesNotThrow(() => B.assertScheduleOnly(ok));
    [{ mode: 'shareNow' }, { mode: 'shareNext' }, { mode: 'addToQueue' }, { mode: 'recommendedTime' }, { mode: undefined }, { saveToDraft: true }, { saveToDraft: undefined },
      { dueAt: undefined }, { dueAt: at(-1) }, { dueAt: at(0.01) }, { dueAt: at(24 * 400) }, { dueAt: '2031-01-01T09:00:00+01:00' }, { dueAt: '2031-01-01' }, { channelId: 'nope' }]
      .forEach((bad) => assert.throws(() => B.assertScheduleOnly(Object.assign({}, ok, bad)), /Refusing/, JSON.stringify(bad)));
  });
  it('the draft path still refuses a scheduled input, and createScheduled refuses before any network call', async () => {
    assert.throws(() => B.assertDraftOnly({ channelId: ch, text: 'x', saveToDraft: true, dueAt: at(24) }), /Refusing/);
    await assert.rejects(() => B.createScheduled({ channelId: ch, text: 'x', saveToDraft: false, mode: 'shareNow', dueAt: at(24) }), /Refusing/);
  });
  it('verifies status, time, sent state, caption, channel and images', () => {
    const dueAt = at(24); const want = { channelId: ch, text: 'Hi', imageUrls: ['https://m/1.jpg'], dueAt };
    const good = { status: 'scheduled', dueAt, sentAt: null, channelId: ch, text: 'Hi', assets: [{ type: 'image', source: 'https://m/1.jpg' }] };
    assert.strictEqual(B.verifyScheduled(good, want).ok, true);
    [[{ status: 'draft' }, /status/], [{ status: 'sent', sentAt: '2027-01-01' }, /status|sent/], [{ dueAt: at(30) }, /time/], [{ dueAt: null }, /time/], [{ text: 'Other' }, /caption/], [{ channelId: 'b'.repeat(24) }, /channel/], [{ assets: [] }, /image/]]
      .forEach(([patch, re]) => { const v = B.verifyScheduled(Object.assign({}, good, patch), want); assert.strictEqual(v.ok, false, JSON.stringify(patch)); assert.match(v.problems.join(' '), re); });
  });
});
