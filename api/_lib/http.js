'use strict';

const { getConfig } = require('./config');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

function send(res, status, body, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, headers || {});
  res.writeHead(status, h);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Turns any thrown error into a safe JSON response. Internal details are logged, never returned.
function sendError(res, err) {
  if (err instanceof HttpError || (err && err.status && err.code)) {
    const body = { error: err.code, message: err.message };
    if (err.errors) body.errors = err.errors;
    if (err.extra) Object.assign(body, err.extra);
    return send(res, err.status, body);
  }
  console.error('Unhandled error:', err && err.stack || err);
  return send(res, 500, { error: 'server_error', message: 'Something went wrong. Nothing was lost; try again.' });
}

async function readJson(req, limit) {
  const max = limit || 1024 * 1024;
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'too_large', 'Request is too large.');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw new HttpError(400, 'bad_json', 'The request was not valid JSON.'); }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// State-changing requests must come from our own pages: Origin must match, and a custom header must be present.
// Combined with SameSite=Strict cookies this blocks cross-site request forgery.
function assertSameOrigin(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;
  const origin = req.headers.origin;
  const host = req.headers.host;
  const allowed = getConfig().allowedOrigins;
  let ok = false;
  if (origin) {
    try { const o = new URL(origin); ok = o.host === host || allowed.includes(o.origin); } catch (_) { ok = false; }
  }
  if (!ok) throw new HttpError(403, 'bad_origin', 'Request blocked: it did not come from this site.');
  if (req.headers['x-requested-with'] !== 'jnr') throw new HttpError(403, 'bad_origin', 'Request blocked: missing header.');
}

module.exports = { HttpError, send, sendError, readJson, parseCookies, clientIp, assertSameOrigin };
