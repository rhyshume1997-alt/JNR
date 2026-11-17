'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const render = require('../api/_lib/render');

const snap = (o) => Object.assign({ slug: 'a-job-1a2b', kind: 'completed', title: 'Flange set', summary: 'Turned and drilled.', body: '', is_case_study: false, material: 'Steel', process: 'CNC turning', stage: null,
  event_date: '2026-11-10', customer: null, images: [{ id: 'i1', url: 'https://media.example.test/public/x/a-1600.jpg', thumb_url: 'https://media.example.test/public/x/a-640.jpg', width: 1600, height: 1000, alt: 'Flange' }] }, o);
const row = (s) => ({ slug: s.slug, live_snapshot: s });

describe('public rendering', () => {
  it('escapes every text field so entries cannot inject markup or script', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'';
    const html = render.renderIndex([row(snap({ title: evil, summary: evil, material: evil, process: evil, images: [{ id: 'i', url: 'https://m/x.jpg', thumb_url: 'https://m/x.jpg', width: 10, height: 10, alt: evil }] }))]);
    assert.ok(!html.includes('<script>alert(1)'), 'no raw script');
    assert.ok(!/<img src=x/.test(html));
    assert.ok(!/onerror=alert/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'handler only appears escaped');
    const cs = render.renderEntry(row(snap({ title: evil, is_case_study: true, body: evil + '\n\n' + evil })));
    assert.ok(!cs.includes('<script>alert(1)') && !/<img src=x/.test(cs));
    const ld = cs.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1];
    assert.doesNotThrow(() => JSON.parse(ld)); assert.ok(!ld.includes('</script'));
  });
  it('shows an empty, noindex page when nothing is published, and an indexable page when something is', () => {
    const empty = render.renderIndex([]);
    assert.match(empty, /noindex/); assert.match(empty, /New work will be added here soon/);
    assert.ok(!/noindex/.test(render.renderIndex([row(snap())])));
  });
  it('separates what is in production from completed work, and links only real case studies', () => {
    const html = render.renderIndex([row(snap({ kind: 'in_production', title: 'On the lathe', stage: 'machining' })), row(snap({ title: 'Plain card' })), row(snap({ title: 'Big job', slug: 'big-job-9f9f', is_case_study: true, body: 'Long write-up.' }))]);
    assert.match(html, /In production now/); assert.match(html, /On the machines/);
    assert.match(html, /href="\/our-work\/big-job-9f9f"/);
    assert.ok(!/href="\/our-work\/a-job-1a2b"/.test(html), 'routine updates stay concise cards with no page');
  });
  it('only names a customer when the approved snapshot carries one', () => {
    assert.ok(!render.renderEntry(row(snap({ is_case_study: true, body: 'x', customer: null }))).includes('Customer'));
    assert.match(render.renderEntry(row(snap({ is_case_study: true, body: 'x', customer: 'A marine firm' }))), /A marine firm/);
  });
  it('builds a small feed with trimmed text and thumbnails', () => {
    const items = render.feedItems([row(snap({ summary: 'word '.repeat(80) }))]);
    assert.ok(items[0].summary.length <= 141); assert.strictEqual(items[0].url, '/our-work'); assert.ok(items[0].image.url.endsWith('-640.jpg'));
  });
});
