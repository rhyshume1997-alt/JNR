'use strict';

const KINDS = ['in_production', 'completed', 'update'];
const KIND_LABELS = { in_production: 'In production', completed: 'Completed', update: 'Workshop update' };

const STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'published', 'failed'];

const STAGES = ['materials_in', 'programming', 'setup', 'machining', 'fabrication', 'finishing', 'inspection', 'ready', 'delivered'];
const STAGE_LABELS = {
  materials_in: 'Material in', programming: 'Programming', setup: 'Setting up', machining: 'On the machines',
  fabrication: 'In fabrication', finishing: 'Finishing', inspection: 'Inspection', ready: 'Ready', delivered: 'Delivered',
};

const ROLES = ['workshop', 'editor', 'admin'];
const ROLE_RANK = { workshop: 1, editor: 2, admin: 3 };

const DESTINATIONS = ['website', 'linkedin'];

// Which status can move to which. Edits to approved/published/failed entries go back to draft (see entries.js).
const TRANSITIONS = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'rejected', 'draft'],
  rejected: ['draft', 'pending_approval'],
  approved: ['published', 'failed', 'draft'],
  failed: ['published', 'approved', 'draft'],
  published: ['draft', 'approved'],
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function hasRole(user, min) {
  return !!user && (ROLE_RANK[user.role] || 0) >= ROLE_RANK[min];
}

class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.status = 422;
    this.code = 'validation';
    this.errors = errors;
  }
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
}

// Validates and normalises the editable fields. `partial` lets PATCH send only some fields.
function validateEntryFields(input, opts) {
  const partial = !!(opts && opts.partial);
  const errors = {};
  const out = {};
  const has = function (k) { return Object.prototype.hasOwnProperty.call(input, k); };

  if (!partial || has('kind')) {
    if (!KINDS.includes(input.kind)) errors.kind = 'Choose in production, completed or workshop update.';
    else out.kind = input.kind;
  }
  if (!partial || has('title')) {
    const t = clean(input.title);
    if (t.length < 3 || t.length > 120) errors.title = 'Job title must be 3 to 120 characters.';
    else out.title = t;
  }
  if (!partial || has('summary')) {
    const s = clean(input.summary);
    if (s.length < 1 || s.length > 600) errors.summary = 'Short description must be 1 to 600 characters.';
    else out.summary = s;
  }
  [['material', 200], ['process', 200]].forEach(function (p) {
    if (has(p[0])) {
      const v = clean(input[p[0]]);
      if (v.length > p[1]) errors[p[0]] = 'Too long.'; else out[p[0]] = v;
    }
  });
  if (has('stage')) {
    const st = input.stage === '' || input.stage == null ? null : input.stage;
    if (st !== null && !STAGES.includes(st)) errors.stage = 'Unknown production stage.'; else out.stage = st;
  }
  if (has('body')) {
    const b = clean(input.body);
    if (b.length > 8000) errors.body = 'Too long.'; else out.body = b;
  }
  if (has('is_case_study')) out.is_case_study = input.is_case_study === true;
  if (has('event_date')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.event_date)) || Number.isNaN(Date.parse(input.event_date))) errors.event_date = 'Use a date like 2026-11-15.';
    else out.event_date = input.event_date;
  }
  [['job_ref', 60], ['customer_name', 200], ['customer_notes', 2000], ['internal_notes', 4000], ['customer_public_label', 120]].forEach(function (p) {
    if (has(p[0])) {
      const v = clean(input[p[0]]);
      if (v.length > p[1]) errors[p[0]] = 'Too long.'; else out[p[0]] = v === '' ? null : v;
    }
  });
  if (has('customer_public_ok')) out.customer_public_ok = input.customer_public_ok === true;
  if (has('destinations')) {
    const d = input.destinations;
    if (!d || typeof d !== 'object') errors.destinations = 'Choose where this goes.';
    else out.destinations = { website: d.website === true, linkedin: d.linkedin === true };
  }
  if (has('caption')) {
    const c = clean(input.caption);
    if (c.length > 3000) errors.caption = 'Caption is too long.'; else out.caption = c;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

function slugify(title) {
  return clean(title).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'job';
}

// Fields whose change means the approved content is out of date.
const CONTENT_FIELDS = ['kind', 'title', 'summary', 'material', 'process', 'stage', 'body', 'is_case_study', 'event_date',
  'customer_public_ok', 'customer_public_label', 'destinations', 'caption'];
// Fields recorded by name only in the audit log (they can hold customer or internal information).
const PRIVATE_FIELDS = ['job_ref', 'customer_name', 'customer_notes', 'internal_notes', 'customer_public_label'];

module.exports = {
  KINDS, KIND_LABELS, STATUSES, STAGES, STAGE_LABELS, ROLES, ROLE_RANK, DESTINATIONS, TRANSITIONS,
  canTransition, hasRole, ValidationError, validateEntryFields, slugify, clean, CONTENT_FIELDS, PRIVATE_FIELDS,
};
