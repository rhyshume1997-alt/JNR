'use strict';

/*
  POST /api/quote
  Takes the quote form (multipart/form-data) with up to 4 drawings, emails it to the
  workshop with Resend and sends the customer a short confirmation.

  Environment variables (set in Vercel, Project Settings, Environment Variables):
    RESEND_API_KEY  required  API key from resend.com
    QUOTE_TO        required  where quote requests go (the owner's Outlook address, comma separate for more than one)
    QUOTE_FROM      optional  sender address on a domain verified in Resend, defaults to info@jnrengineering.co.uk
*/

const Busboy = require('busboy');
const antispam = require('./_lib/antispam');
const TURNSTILE_HOSTNAMES = process.env.TURNSTILE_HOSTNAMES
  ? process.env.TURNSTILE_HOSTNAMES.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean)
  : ['jnrengineering.co.uk', 'www.jnrengineering.co.uk'];

const MAX_FILES = 4;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4MB of drawings in total (Vercel functions accept about 4.5MB per request)
const ALLOWED_EXT = ['pdf', 'dxf', 'dwg', 'step', 'stp', 'iges', 'igs', 'stl', 'jpg', 'jpeg', 'png'];
// RHYS TO SUPPLY: which domain is verified in Resend for sending. The website is jnrengineering.co.uk but the mailboxes use jnrengineeringltd.co.uk. Set QUOTE_FROM in Vercel to an address on the verified domain
const DEFAULT_FROM = 'info@jnrengineering.co.uk';
const WORKSHOP_PHONE = '0141 647 5913';

// Basic rate limit, per IP, kept in memory. Vercel keeps warm instances for a while, so this slows down
// a script hammering one instance. For anything stronger use Vercel's firewall rate limiting.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  if (recent.length >= RATE_MAX) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 2000) {
    hits.forEach(function (list, key) {
      if (!list.some(function (t) { return now - t < RATE_WINDOW_MS; })) hits.delete(key);
    });
  }
  return false;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function wantsJson(req) {
  return String(req.headers.accept || '').indexOf('application/json') !== -1;
}

function send(req, res, status, body, redirectTo) {
  if (!wantsJson(req) && redirectTo) {
    res.statusCode = 303;
    res.setHeader('Location', redirectTo);
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function oneLine(value, max) {
  return clean(value, max).replace(/[\r\n]+/g, ' ');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function safeFilename(name) {
  const base = String(name || 'drawing').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '');
  return base.slice(-100) || 'drawing';
}

function extensionOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// Cheap check that a .pdf, .png or .jpg really is one. The CAD and STL formats are left alone, they vary too much.
function looksRight(ext, buf) {
  if (ext === 'pdf') return buf.slice(0, 1024).toString('latin1').indexOf('%PDF') !== -1;
  if (ext === 'png') return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ext === 'jpg' || ext === 'jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  return true;
}

function parseForm(req) {
  return new Promise(function (resolve, reject) {
    const fields = {};
    const files = [];
    let total = 0;
    let failed = null;
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: MAX_FILES, fileSize: MAX_TOTAL_BYTES + 1, fields: 40, fieldSize: 20000, parts: 60 }
      });
    } catch (e) {
      reject({ status: 400, message: 'That request could not be read.' });
      return;
    }
    bb.on('field', function (name, value) { fields[name] = value; });
    bb.on('file', function (name, stream, info) {
      const filename = info.filename || '';
      const chunks = [];
      let size = 0;
      stream.on('data', function (d) {
        size += d.length;
        total += d.length;
        if (total <= MAX_TOTAL_BYTES) chunks.push(d);
      });
      stream.on('limit', function () { failed = failed || { status: 413, message: 'Your drawings are over 4MB in total.' }; });
      stream.on('end', function () {
        if (!filename || size === 0) return; // no file chosen
        files.push({ filename: filename, size: size, data: Buffer.concat(chunks) });
      });
    });
    bb.on('filesLimit', function () { failed = failed || { status: 413, message: 'Please send no more than 4 drawings.' }; });
    bb.on('error', function () { reject({ status: 400, message: 'That request could not be read.' }); });
    bb.on('close', function () {
      if (total > MAX_TOTAL_BYTES) failed = failed || { status: 413, message: 'Your drawings are over 4MB in total.' };
      if (failed) reject(failed); else resolve({ fields: fields, files: files });
    });
    req.pipe(bb);
  });
}

function validate(fields, files) {
  const errors = {};
  const data = {
    name: oneLine(fields.full_name || fields.name, 100),
    company: oneLine(fields.company, 120),
    phone: oneLine(fields.phone, 30),
    email: oneLine(fields.email, 200),
    service: oneLine(fields.service, 60),
    quantity: oneLine(fields.quantity, 60),
    material: oneLine(fields.material, 120),
    requiredBy: oneLine(fields.required_by, 10),
    message: clean(fields.message, 5000),
    urgent: String(fields.urgent || '').toLowerCase() === 'yes' || String(fields.urgent || '').toLowerCase() === 'on'
  };

  if (data.name.length < 2) errors.full_name = 'Please give us your name.';
  if (!data.company) errors.company = 'Please give us your company name.';
  if (!/^[\d\s+()\-.]{6,30}$/.test(data.phone)) errors.phone = 'That phone number does not look right.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || data.email.length > 200) errors.email = 'That email address does not look right.';
  if (data.requiredBy) {
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(data.requiredBy) && !isNaN(Date.parse(data.requiredBy));
    if (!ok) errors.required_by = 'That date does not look right.';
  }

  if (files.length > MAX_FILES) errors.drawings = 'Please send no more than 4 drawings.';
  const clean_files = [];
  let total = 0;
  files.forEach(function (f) {
    const ext = extensionOf(f.filename);
    total += f.size;
    if (ALLOWED_EXT.indexOf(ext) === -1) {
      errors.drawings = 'We can take PDF, DXF, DWG, STEP, IGES, STL, JPG and PNG files.';
    } else if (!looksRight(ext, f.data)) {
      errors.drawings = '"' + safeFilename(f.filename) + '" does not look like a real ' + ext.toUpperCase() + ' file.';
    } else {
      clean_files.push({ filename: safeFilename(f.filename), data: f.data });
    }
  });
  if (total > MAX_TOTAL_BYTES) errors.drawings = 'Your drawings are over 4MB in total.';

  return { errors: errors, data: data, files: clean_files };
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function ownerEmail(data, files) {
  const rows = [
    ['Name', data.name],
    ['Company', data.company],
    ['Phone', data.phone],
    ['Email', data.email],
    ['Service', data.service || 'Not said'],
    ['Quantity', data.quantity || 'Not said'],
    ['Material', data.material || 'Not said'],
    ['Required by', data.requiredBy ? formatDate(data.requiredBy) : 'Not said'],
    ['Urgent or breakdown', data.urgent ? 'Yes' : 'No'],
    ['Drawings attached', files.length ? files.map(function (f) { return f.filename; }).join(', ') : 'None']
  ];
  const text = rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n') + '\n\nAbout the job:\n' + (data.message || 'Nothing written.') + '\n\nReply to this email to reach the customer.';
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#031339">' +
    '<table cellpadding="6" style="border-collapse:collapse">' +
    rows.map(function (r) { return '<tr><td style="color:#555;vertical-align:top"><b>' + escapeHtml(r[0]) + '</b></td><td>' + escapeHtml(r[1]) + '</td></tr>'; }).join('') +
    '</table><p><b>About the job</b><br>' + escapeHtml(data.message || 'Nothing written.').replace(/\n/g, '<br>') + '</p>' +
    '<p style="color:#555">Reply to this email to reach the customer.</p></div>';
  return { text: text, html: html };
}

// The only thing from the form that goes into the customer's confirmation: a first name made of letters,
// hyphens and apostrophes, 40 characters at most, or "there" if nothing usable is left.
function safeFirstName(name) {
  const cleaned = String(name || '').normalize('NFC').replace(/[^\p{L}\s'\u2019-]/gu, ' ').trim();
  const first = (cleaned.split(/\s+/)[0] || '').replace(/^['\u2019-]+|['\u2019-]+$/g, '').slice(0, 40);
  return first || 'there';
}

function customerEmail(data) {
  const first = safeFirstName(data.name);
  const text = 'Hi ' + first + ',\n\nThanks, we\u2019ve got your drawing and will be in touch.\n\n' +
    'If it is a breakdown or an urgent job, phone the workshop on ' + WORKSHOP_PHONE + ' as well.\n\n' +
    'If you need to add anything, reply to this email or phone the workshop on ' + WORKSHOP_PHONE + '.\n\nJ.N.R. Engineering Ltd\nHamilton';
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#031339">' +
    '<p>Hi ' + escapeHtml(first) + ',</p><p>Thanks, we\u2019ve got your drawing and will be in touch.</p>' +
    '<p>If it is a breakdown or an urgent job, phone the workshop on <a href="tel:01416475913">' + WORKSHOP_PHONE + '</a> as well.</p>' +
    '<p>If you need to add anything, reply to this email or phone the workshop on <a href="tel:01416475913">' + WORKSHOP_PHONE + '</a>.</p>' +
    '<p>J.N.R. Engineering Ltd<br>Hamilton</p></div>';
  return { text: text, html: html };
}

async function resendSend(payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) { /* ignore */ }
    throw new Error('Resend ' + res.status + ' ' + detail.slice(0, 300));
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(req, res, 405, { ok: false, error: 'Please use the quote form.' }, '/quote');
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return send(req, res, 429, { ok: false, error: 'You\u2019ve sent a few requests in a short time. Please wait a few minutes and try again.' }, '/quote?sent=error');
  }

  let parsed;
  try {
    const type = String(req.headers['content-type'] || '');
    if (type.indexOf('multipart/form-data') === -1) throw { status: 400, message: 'Please use the quote form.' };
    parsed = await parseForm(req);
  } catch (err) {
    return send(req, res, (err && err.status) || 400, { ok: false, error: (err && err.message) || 'That request could not be read.' }, '/quote?sent=error');
  }

  const fields = parsed.fields;

  // Spam: a hidden field people never see, and forms that were sent faster than a person could fill them in
  const started = parseInt(fields._t, 10);
  const tooFast = started && Date.now() - started < 2500;
  if (clean(fields.company_website, 200) || tooFast) {
    return send(req, res, 200, { ok: true }, '/thanks'); // looks like success, nothing is sent
  }

  // Turnstile: mandatory server side check. A missing or bad token never reaches the email step.
  const human = await antispam.verifyTurnstile({
    token: fields['cf-turnstile-response'],
    secret: process.env.TURNSTILE_SECRET_KEY,
    ip: ip,
    expectedAction: 'quote',
    allowedHostnames: TURNSTILE_HOSTNAMES
  });
  if (!human.ok) {
    console.warn('quote: turnstile refused', human.reason, human.codes || '');
    if (human.reason === 'unavailable' || human.reason === 'not_configured') {
      return send(req, res, 503, { ok: false, error: 'The form isn’t working right now.' }, '/quote?sent=error');
    }
    return send(req, res, 400, { ok: false, errors: { captcha: 'check failed' }, error: 'Please let the security check finish and send it again.' }, '/quote?sent=error');
  }

  const checked = validate(fields, parsed.files);
  if (Object.keys(checked.errors).length) {
    return send(req, res, 400, { ok: false, errors: checked.errors, error: 'Some details need another look.' }, '/quote?sent=error');
  }

  const to = String(process.env.QUOTE_TO || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!process.env.RESEND_API_KEY || !to.length) {
    console.error('quote: RESEND_API_KEY or QUOTE_TO is not set');
    return send(req, res, 500, { ok: false, error: 'The form isn\u2019t working right now.' }, '/quote?sent=error');
  }
  const from = '"J.N.R. Engineering Quotes" <' + (process.env.QUOTE_FROM || DEFAULT_FROM) + '>';
  const d = checked.data;

  // Suspicious enquiries (SEO and marketing pitches) are held for review, never deleted, and get no confirmation email
  const verdict = antispam.classify({
    name: d.name, company: d.company, email: d.email, message: d.message,
    service: d.service, quantity: d.quantity, material: d.material, fileCount: checked.files.length
  });
  if (verdict.quarantine) {
    const target = antispam.quarantineTarget(process.env, to);
    try {
      const owner = ownerEmail(d, checked.files);
      const note = antispam.quarantineNote(verdict, target.separate);
      await resendSend({
        from: from,
        to: target.to,
        reply_to: d.email,
        subject: antispam.quarantineSubject((d.urgent ? 'URGENT: ' : '') + 'New quote request – ' + d.company, verdict),
        text: note + owner.text,
        html: '<p style="font-family:Arial,sans-serif;background:#fff3cd;padding:10px">' + escapeHtml(note) + '</p>' + owner.html,
        attachments: checked.files.map(function (f) { return { filename: f.filename, content: f.data.toString('base64') }; })
      });
    } catch (err) {
      console.error('quote: quarantine email failed', err && err.message);
      return send(req, res, 502, { ok: false, error: 'Your request didn’t send.' }, '/quote?sent=error');
    }
    console.warn('quote: quarantined', verdict.score, verdict.reasons.join('; '));
    return send(req, res, 200, { ok: true }, '/thanks'); // the sender sees the normal thank you page
  }

  try {
    const owner = ownerEmail(d, checked.files);
    await resendSend({
      from: from,
      to: to,
      reply_to: d.email,
      subject: (d.urgent ? 'URGENT: ' : '') + 'New quote request – ' + d.company,
      text: owner.text,
      html: owner.html,
      attachments: checked.files.map(function (f) { return { filename: f.filename, content: f.data.toString('base64') }; })
    });
  } catch (err) {
    console.error('quote: owner email failed', err && err.message);
    return send(req, res, 502, { ok: false, error: 'Your request didn\u2019t send.' }, '/quote?sent=error');
  }

  // The confirmation is a courtesy, a failure here must not lose the request
  try {
    const mail = customerEmail(d);
    await resendSend({
      from: from,
      to: [d.email],
      reply_to: to,
      subject: 'We\'ve got your drawing | J.N.R. Engineering',
      text: mail.text,
      html: mail.html
    });
  } catch (err) {
    console.error('quote: confirmation email failed', err && err.message);
  }

  return send(req, res, 200, { ok: true }, '/thanks');
};
