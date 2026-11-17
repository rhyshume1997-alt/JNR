'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { scanPublicText, looksLikePurchaseOrder } = require('../api/_lib/confidential');

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

  describe('purchase order references', () => {
    const poCodes = (text, field) => codes(scanPublicText(e({ [field || 'summary']: text }))).filter((c) => c === 'po_number');

    it('accepts ordinary engineering descriptions, including words that merely start with "po"', () => {
      [
        'Powder coated brackets', 'Polished stainless flange', 'Portable guard', 'Position sensor bracket', 'Pocket milling',
        'Polymer bushes turned from acetal', 'Power take-off shaft', 'Porous filter plate', 'Port 8080 manifold', 'Positioning table, 5 axis',
        'Pole 316 stainless', 'POWER5000 drive housing', 'Postal tray', 'P.O. Box tray', 'The purchase order was raised last week',
        'Polished 316 stainless, powder coated frames, portable guards and position sensor brackets',
        'Polished 316', 'Power 5kW', 'Position 3 sensor', 'Post 100x100', 'Power 400V', 'Polypropylene 12', 'PowerPoint 2024', 'H3PO4', 'PO box 123',
        'Port number is a part of the housing', 'Position is 316 stainless',
      ].forEach((text) => {
        assert.strictEqual(looksLikePurchaseOrder(text), false, text);
        ['title', 'summary', 'body', 'material', 'process', 'caption'].forEach((f) => assert.deepStrictEqual(poCodes(text, f), [], f + ': ' + text));
      });
    });

    it('still blocks genuine purchase order references, in every public field', () => {
      [
        'PO 12345', 'PO12345', 'PO number 12345', 'PO#12345', 'Purchase order 12345', 'po 4500012345', 'P.O. 12345', 'P.O. No. 12345',
        'PO: AB-1234', 'PO AB1234', 'PO-4500012345', 'PO no. 45/123', 'PO # 77821', 'PO Ref ABC123', 'P/O 12345', 'PO ref. X9-221',
        'Purchase Order Number: JNR-0021', 'purchase order: 99812', 'Our PO 12345 for flanges', 'Flanges (PO4500012345) delivered',
        // how customers actually write it
        'The PO number is 12345', 'PO number was 12345', 'PO number for this job: 12345', 'PO reference number 12345', 'PO numbers 12345 and 12346', 'PO issued 12345',
        'PO # : 12345', 'PO #: 12345', 'PO number (12345)', 'PO ref: (AB123)', 'PONo 12345', 'PONumber 12345', 'PO-No 12345', 'PO_12345', 'PO_No_12345',
        'PO \u2013 12345', 'PO\u201112345', 'PO/12345', 'PO / 12345', 'PO 12.345', 'PO ID 12345', 'PO is 12345', 'PO of 12345', 'PO Nr 12345', 'PO nr. 12345',
        'P. O. 12345', 'Purchase-order 12345', 'PurchaseOrder 12345', 'Purchase order \u2013 12345', 'Purchase order is 12345', 'Purchase order (12345)',
        'Purchase order Nr 12345', 'Purchase order12345', 'PO number, 12345', 'PO number; 12345', 'PO number = 12345', 'PO number. 12345', 'PO ref=12345', 'PO number \u201c12345\u201d', 'Customer PO#12345', 'Cust PO 12345', 'PO\t12345', 'PO\n12345', 'PO\u00a012345',
      ].forEach((text) => {
        assert.strictEqual(looksLikePurchaseOrder(text), true, text);
        ['title', 'summary', 'body', 'material', 'process', 'caption'].forEach((f) => assert.deepStrictEqual(poCodes(text, f), ['po_number'], f + ': ' + text));
      });
    });

    it('blocks a reference hidden among ordinary words, and does not let ordinary words hide it', () => {
      assert.deepStrictEqual(poCodes('Powder coated brackets for PO 4500012345, polished and portable'), ['po_number']);
      assert.deepStrictEqual(poCodes('Powder coated brackets, polished and portable'), []);
    });

    it('is fast on very long runs of spaces and repeats (no catastrophic backtracking)', () => {
      const t0 = Date.now();
      ['purchase order' + ' '.repeat(100000), 'PO no' + ' '.repeat(100000), 'PO number ' + 'a '.repeat(50000), 'PO '.repeat(40000), 'purchase order '.repeat(7000), 'PO:::'.repeat(20000)]
        .forEach((t) => looksLikePurchaseOrder(t));
      assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0) + ' ms');
    });

    it('the other confidentiality checks are unchanged', () => {
      const r = scanPublicText(e({ summary: 'Powder coated for Acme Marine, JOB-7742, ring 07700 900123, buyer@acme.com.' }));
      ['customer_name', 'job_ref', 'phone', 'email'].forEach((c) => assert.ok(codes(r).includes(c), c));
      assert.ok(!codes(r).includes('po_number'), 'and "Powder" is not a purchase order');
    });
  });
});
