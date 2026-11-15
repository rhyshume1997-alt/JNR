'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { scanPublicText } = require('../api/_lib/confidential');

const e = (o) => Object.assign({ title: 'Flange set', summary: 'Turned and drilled.', customer_name: 'Acme Marine', job_ref: 'JOB-7742', customer_public_ok: false }, o);
const codes = (r) => r.blocking.map((b) => b.code).concat(r.warnings.map((w) => w.code));

describe('confidentiality scan', () => {
  it('passes clean text', () => assert.deepStrictEqual(scanPublicText(e()), { blocking: [], warnings: [] }));
  it('blocks the customer name in any public field, case-insensitively, but not inside other words', () => {
    assert.ok(codes(scanPublicText(e({ summary: 'Made for ACME marine last week.' }))).includes('customer_name'));
    assert.ok(codes(scanPublicText(e({ caption: 'Thanks Acme Marine!' }))).includes('customer_name'));
    assert.ok(!codes(scanPublicText(e({ customer_name: 'Ace', summary: 'A surface finish.' }))).includes('customer_name'));
  });
  it('allows the customer name only with explicit consent', () => {
    assert.ok(!codes(scanPublicText(e({ summary: 'Made for Acme Marine.', customer_public_ok: true }))).includes('customer_name'));
  });
  it('blocks job references, emails, phone numbers and PO numbers', () => {
    const r = scanPublicText(e({ summary: 'See JOB-7742, email buyer@acme.com, ring 07700 900123, PO 4500012345.' }));
    ['job_ref', 'email', 'phone', 'po_number'].forEach((c) => assert.ok(codes(r).includes(c), c));
  });
  it('warns about drawing numbers, revisions, tolerances and part numbers', () => {
    const r = scanPublicText(e({ body: 'Drawing no. AB-1234 rev C, tolerance ±0.01, part XY-90210.' }));
    ['drawing_reference', 'tolerance', 'part_number'].forEach((c) => assert.ok(codes(r).includes(c), c));
    assert.strictEqual(r.blocking.length, 0);
  });
  it('never scans or reports private fields as public text', () => {
    const r = scanPublicText(e({ internal_notes: 'Acme Marine margin', customer_notes: 'phone 0141 555 0100' }));
    assert.deepStrictEqual(r, { blocking: [], warnings: [] });
  });
});
