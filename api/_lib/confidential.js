'use strict';

// Checks the text that would become public (and the caption) for things that must not go out by accident.
// "blocking" findings stop approval. "warnings" need the approver to tick that they have checked them.

const PUBLIC_TEXT_FIELDS = ['title', 'summary', 'body', 'material', 'process', 'caption', 'customer_public_label'];

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function scanPublicText(entry) {
  const blocking = [];
  const warnings = [];
  const fields = {};
  PUBLIC_TEXT_FIELDS.forEach(function (f) { if (entry[f]) fields[f] = String(entry[f]); });

  const customer = (entry.customer_name || '').trim();
  const jobRef = (entry.job_ref || '').trim();
  const customerOk = entry.customer_public_ok === true;

  Object.keys(fields).forEach(function (f) {
    const text = fields[f];
    if (customer.length >= 3 && !customerOk && f !== 'customer_public_label') {
      if (new RegExp('(^|[^a-z0-9])' + escRe(customer) + '([^a-z0-9]|$)', 'i').test(text)) {
        blocking.push({ code: 'customer_name', field: f, message: 'The customer name appears in the ' + f + '. Remove it, or have an admin allow naming the customer.' });
      }
    }
    if (customer.length >= 3 && f === 'customer_public_label' && customerOk === false) {
      blocking.push({ code: 'customer_label_without_consent', field: f, message: 'A public customer label is set but naming the customer is not allowed.' });
    }
    if (jobRef.length >= 3 && text.toLowerCase().includes(jobRef.toLowerCase())) {
      blocking.push({ code: 'job_ref', field: f, message: 'The internal job reference appears in the ' + f + '.' });
    }
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) blocking.push({ code: 'email', field: f, message: 'An email address appears in the ' + f + '.' });
    if (/(?:\+44|\b0)\s?\d[\d\s]{8,12}\d/.test(text)) blocking.push({ code: 'phone', field: f, message: 'A phone number appears in the ' + f + '.' });
    if (/\b(?:po|purchase order)\s*(?:no\.?|number|#)?\s*[:#-]?\s*[A-Z0-9-]{3,}/i.test(text)) blocking.push({ code: 'po_number', field: f, message: 'A purchase order number appears in the ' + f + '.' });

    if (/\b(?:dwg|drg|drawing)\s*(?:no\.?|number|ref\.?|#)?\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{2,}/i.test(text) || /\brev(?:ision)?\s*[:#-]?\s*[A-Z0-9]\b/i.test(text)) {
      warnings.push({ code: 'drawing_reference', field: f, message: 'Looks like a drawing number or revision in the ' + f + '. Customer drawings are confidential.' });
    }
    if (/[±]\s*\d|\btolerance[sd]?\b|\b\d+(?:\.\d+)?\s*(?:µm|micron|microns)\b/i.test(text)) {
      warnings.push({ code: 'tolerance', field: f, message: 'Mentions a tolerance in the ' + f + '. Confirm it can be shared.' });
    }
    if (/\b[A-Z]{2,5}[-/ ]?\d{4,}[A-Z0-9-]*\b/.test(text)) {
      warnings.push({ code: 'part_number', field: f, message: 'Looks like a part number in the ' + f + '. Confirm it is not the customer\'s.' });
    }
  });
  return { blocking: dedupe(blocking), warnings: dedupe(warnings) };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(function (x) { const k = x.code + ':' + x.field; if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = { scanPublicText };
