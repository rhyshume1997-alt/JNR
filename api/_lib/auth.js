'use strict';

const crypto = require('node:crypto');
const { query } = require('./db');
const { getConfig } = require('./config');
const { HttpError, parseCookies } = require('./http');
const { hasRole, ROLES } = require('./model');

const COOKIE = 'jnr_session';
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// OWASP-recommended scrypt cost (N=2^16, r=8, p=1). Stored with each hash, so it can be raised later without breaking logins.
const SCRYPT = { N: 65536, r: 8, p: 1, keylen: 64 };
const IP_FAIL_LIMIT = 20;
const IP_FAIL_WINDOW_MIN = 10;

function scryptAsync(pw, salt, opts) {
  return new Promise((resolve, reject) => crypto.scrypt(pw, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function pbkdf2Async(pw, salt, iterations) {
  return new Promise((resolve, reject) => crypto.pbkdf2(pw, salt, iterations, 32, 'sha256', (e, k) => (e ? reject(e) : resolve(k))));
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  // pbkdf2$<iterations>$<salt>$<hash>: a hash that can be made without this server's code (WebCrypto or any PBKDF2 tool), so an
  // administrator can be created or reset with plain SQL. Replaced by a scrypt hash on the first successful sign-in (see login()).
  if (parts[0] === 'pbkdf2' && parts.length === 4) {
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 5000000) return false;
    const key = await pbkdf2Async(password, Buffer.from(parts[2], 'base64'), iterations);
    const expected = Buffer.from(parts[3], 'base64');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  }
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const opts = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), keylen: 64 };
  const key = await scryptAsync(password, Buffer.from(parts[4], 'base64'), opts);
  const expected = Buffer.from(parts[5], 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Runs a hash for unknown emails too, so response time does not reveal which emails exist.
let dummyHash = null;
async function burnTime(password) {
  if (!dummyHash) dummyHash = await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (/^(.)\1+$/.test(pw)) return 'Use a less repetitive password.';
  return null;
}

function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

function sessionCookie(token, maxAgeSeconds) {
  const secure = getConfig().cookieSecure ? '; Secure' : '';
  return COOKIE + '=' + token + '; HttpOnly; SameSite=Strict; Path=/' + secure + '; Max-Age=' + maxAgeSeconds;
}
function clearCookie() { return sessionCookie('', 0); }

async function audit(client, actor, action, entryId, detail) {
  const q = client ? client.query.bind(client) : query;
  await q('insert into audit_log (actor_id, actor_email, action, entry_id, detail) values ($1,$2,$3,$4,$5)',
    [actor && actor.id || null, actor && actor.email || null, action, entryId || null, JSON.stringify(detail || {})]);
}

async function login(email, password, ip, userAgent) {
  const e = String(email || '').trim().toLowerCase();
  // Slow down guessing across many accounts from one address (per-account lockout alone would not stop that).
  if (ip && ip !== 'unknown') {
    const recent = await query("select count(*)::int as n from audit_log where action = 'login_failed' and at > now() - make_interval(mins => $2) and detail->>'ip' = $1", [ip, IP_FAIL_WINDOW_MIN]);
    if (recent.rows[0].n >= IP_FAIL_LIMIT) throw new HttpError(429, 'too_many', 'Too many failed sign-ins from this connection. Try again in ' + IP_FAIL_WINDOW_MIN + ' minutes.');
  }
  const generic = new HttpError(401, 'bad_login', 'Email or password is not right.');
  if (!e || typeof password !== 'string' || !password) throw generic;
  const { rows } = await query('select * from users where lower(email) = $1', [e]);
  const user = rows[0];
  if (!user) { await burnTime(password); await audit(null, { email: e }, 'login_failed', null, { reason: 'unknown_user', ip }); throw generic; }
  if (user.disabled) { await burnTime(password); await audit(null, user, 'login_failed', null, { reason: 'disabled', ip }); throw generic; }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await audit(null, user, 'login_blocked', null, { ip });
    throw new HttpError(429, 'locked', 'Too many wrong passwords. Try again in ' + LOCK_MINUTES + ' minutes.');
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const fails = user.failed_attempts + 1;
    const lock = fails >= MAX_FAILS;
    await query('update users set failed_attempts = $2, locked_until = $3 where id = $1',
      [user.id, lock ? 0 : fails, lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null]);
    await audit(null, user, 'login_failed', null, { reason: 'bad_password', ip, locked: lock });
    throw generic;
  }
  await query('update users set failed_attempts = 0, locked_until = null where id = $1', [user.id]);
  if (/^pbkdf2\$/.test(user.password_hash)) await query('update users set password_hash = $2 where id = $1', [user.id, await hashPassword(password)]); // upgrade to scrypt
  await query('delete from sessions where expires_at < now()');
  const token = crypto.randomBytes(32).toString('base64url');
  const hours = getConfig().sessionHours;
  await query('insert into sessions (user_id, token_hash, expires_at, user_agent) values ($1,$2,$3,$4)',
    [user.id, tokenHash(token), new Date(Date.now() + hours * 3600000), String(userAgent || '').slice(0, 200)]);
  await audit(null, user, 'login', null, { ip });
  return { token, maxAge: hours * 3600, user: publicUser(user) };
}

function publicUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role }; }

async function getSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const { rows } = await query(
    'select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now() and u.disabled = false',
    [tokenHash(token)]);
  return rows[0] ? publicUser(rows[0]) : null;
}

async function logout(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await query('delete from sessions where token_hash = $1', [tokenHash(token)]);
}

async function requireUser(req, minRole) {
  const user = await getSession(req);
  if (!user) throw new HttpError(401, 'not_signed_in', 'Please sign in.');
  if (minRole && !hasRole(user, minRole)) throw new HttpError(403, 'forbidden', 'Your account is not allowed to do that.');
  return user;
}

async function createUser(actor, input) {
  const email = String(input.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(422, 'validation', 'Enter a valid email.', { errors: { email: 'Enter a valid email.' } });
  if (!ROLES.includes(input.role)) throw new HttpError(422, 'validation', 'Unknown role.', { errors: { role: 'Choose workshop, editor or admin.' } });
  const name = String(input.name || '').trim();
  if (!name) throw new HttpError(422, 'validation', 'Name is required.', { errors: { name: 'Name is required.' } });
  const problem = passwordProblem(input.password);
  if (problem) throw new HttpError(422, 'validation', problem, { errors: { password: problem } });
  const hash = await hashPassword(input.password);
  try {
    const { rows } = await query('insert into users (email, name, role, password_hash) values ($1,$2,$3,$4) returning *', [email, name, input.role, hash]);
    await audit(null, actor, 'user_created', null, { user_id: rows[0].id, email, role: input.role });
    return publicUser(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'exists', 'A user with that email already exists.');
    throw e;
  }
}

module.exports = { COOKIE, hashPassword, verifyPassword, passwordProblem, login, logout, getSession, requireUser, createUser,
  sessionCookie, clearCookie, audit, publicUser, tokenHash };
