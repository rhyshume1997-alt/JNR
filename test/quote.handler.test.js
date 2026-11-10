'use strict';

// Runs the real api/quote.js handler behind a local HTTP server, with Cloudflare and Resend faked.
// No real emails are sent: any call to Resend or Cloudflare is answered by the fakes below.
// Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const handler = require('../api/quote');
const realFetch = globalThis.fetch;

const ENV_KEYS = ['RESEND_API_KEY', 'QUOTE_TO', 'QUOTE_FROM', 'TURNSTILE_SECRET_KEY', 'QUOTE_QUARANTINE_TO'];
const savedEnv = {};
ENV_KEYS.forEach(function (k) { savedEnv[k] = process.env[k]; });

let server;
let baseUrl;
let calls;       // every outside call the handler tried to make
let cloudflare;  // what the fake Cloudflare answers
let resendFails; // make the fake Resend fail
let ipCounter = 0;

function fakeOutside(url, init) {
  const u = String(url);
  if (u.indexOf('https://challenges.cloudflare.com/') === 0) {
    calls.push({ to: 'cloudflare', url: u, body: init.body });
    if (cloudflare === 'down') return Promise.reject(new Error('network down'));
    return Promise.resolve(new Response(JSON.stringify(cloudflare), { status: 200 }));
  }
  if (u.indexOf('https://api.resend.com/') === 0) {
    const payload = JSON.parse(init.body);
    calls.push({ to: 'resend', url: u, payload: payload, auth: init.headers.Authorization });
    if (resendFails) return Promise.resolve(new Response('{"message":"fake failure"}', { status: 500 }));
    return Promise.resolve(new Response('{"id":"fake-email-id"}', { status: 200 }));
  }
  // Anything else is a request from the test itself to the local server
  if (u.indexOf(baseUrl) === 0) return realFetch(url, init);
  return Promise.reject(new Error('Unexpected outside call blocked by the test: ' + u));
}

test.before(async function () {
  server = http.createServer(function (req, res) { handler(req, res); });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  globalThis.fetch = fakeOutside;
});

test.after(async function () {
  globalThis.fetch = realFetch;
  ENV_KEYS.forEach(function (k) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; });
  await new Promise(function (r) { server.close(r); });
});

test.beforeEach(function () {
  calls = [];
  resendFails = false;
  cloudflare = { success: true, hostname: 'jnrengineering.co.uk', action: 'quote' };
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.QUOTE_TO = 'workshop@example.com';
  process.env.TURNSTILE_SECRET_KEY = 'test-turnstile-secret';
  delete process.env.QUOTE_FROM;
  delete process.env.QUOTE_QUARANTINE_TO;
});

const GENUINE = {
  full_name: 'Sam Reid',
  company: 'Reid Hydraulics',
  phone: '0141 000 0000',
  email: 'sam@reid.example',
  service: 'CNC Milling',
  quantity: '50',
  material: 'Aluminium 6082',
  message: 'Need 50 off aluminium brackets, drawing attached, tolerance +/-0.05mm.',
  'cf-turnstile-response': 'good-token'
};

const SEO_PITCH = {
  full_name: 'Mark Jones',
  company: 'RankHigh Ltd',
  phone: '0141 111 1111',
  email: 'mark@rankhigh.example',
  message: 'Hi, we noticed your website is not on the first page of Google. We offer SEO services to boost your traffic. Free audit at www.rankhigh.example',
  'cf-turnstile-response': 'good-token'
};

// Each test uses its own IP so the handler's in-memory rate limit never gets in the way
async function post(fields, opts) {
  const o = opts || {};
  const fd = new FormData();
  Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
  fd.append('_t', String(Date.now() - 30000)); // filled in 30 seconds ago, like a person
  (o.files || []).forEach(function (f) { fd.append('drawings', new Blob([f.data]), f.name); });
  ipCounter += 1;
  const res = await fetch(baseUrl + '/api/quote', {
    method: 'POST',
    body: fd,
    redirect: 'manual',
    headers: Object.assign({ 'x-forwarded-for': '10.0.0.' + ipCounter }, o.json === false ? {} : { Accept: 'application/json' })
  });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body: body, location: res.headers.get('location') };
}

const resendCalls = function () { return calls.filter(function (c) { return c.to === 'resend'; }); };
const cloudflareCalls = function () { return calls.filter(function (c) { return c.to === 'cloudflare'; }); };

test('handler: genuine quote with a drawing goes to the workshop and the customer gets a confirmation', async function () {
  const pdf = { name: 'bracket.pdf', data: Buffer.from('%PDF-1.7\nfake drawing') };
  const r = await post(GENUINE, { files: [pdf] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true });

  const cf = cloudflareCalls();
  assert.strictEqual(cf.length, 1);
  assert.strictEqual(cf[0].body.get('secret'), 'test-turnstile-secret');
  assert.strictEqual(cf[0].body.get('response'), 'good-token');

  const sent = resendCalls();
  assert.strictEqual(sent.length, 2);
  const owner = sent[0].payload;
  assert.deepStrictEqual(owner.to, ['workshop@example.com']);
  assert.strictEqual(owner.reply_to, 'sam@reid.example');
  assert.strictEqual(owner.subject, 'New quote request – Reid Hydraulics');
  assert.doesNotMatch(owner.subject, /SPAM REVIEW/);
  assert.strictEqual(owner.attachments.length, 1);
  assert.strictEqual(owner.attachments[0].filename, 'bracket.pdf');
  assert.strictEqual(Buffer.from(owner.attachments[0].content, 'base64').toString(), '%PDF-1.7\nfake drawing');
  assert.strictEqual(sent[0].auth, 'Bearer test-resend-key');
  const confirmation = sent[1].payload;
  assert.deepStrictEqual(confirmation.to, ['sam@reid.example']);
});

test('handler: honeypot filled gets a fake thank you and nothing is checked or sent', async function () {
  const r = await post(Object.assign({}, GENUINE, { company_website: 'http://spam.example' }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true });
  assert.strictEqual(calls.length, 0);
});

test('handler: honeypot without JavaScript redirects to the thank you page, nothing sent', async function () {
  const r = await post(Object.assign({}, GENUINE, { company_website: 'spam' }), { json: false });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.location, '/thanks');
  assert.strictEqual(calls.length, 0);
});

test('handler: bad Turnstile token is refused with 400 and no email is sent', async function () {
  cloudflare = { success: false, 'error-codes': ['invalid-input-response'] };
  const r = await post(Object.assign({}, GENUINE, { 'cf-turnstile-response': 'forged' }));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.ok, false);
  assert.ok(r.body.errors && r.body.errors.captcha);
  assert.strictEqual(cloudflareCalls().length, 1);
  assert.strictEqual(resendCalls().length, 0);
});

test('handler: missing Turnstile token is refused without asking Cloudflare, no email sent', async function () {
  const fields = Object.assign({}, GENUINE);
  delete fields['cf-turnstile-response'];
  const r = await post(fields);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(calls.length, 0);
});

test('handler: token from another site is refused, no email sent', async function () {
  cloudflare = { success: true, hostname: 'evil.example', action: 'quote' };
  const r = await post(GENUINE);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(resendCalls().length, 0);
});

test('handler: Cloudflare down fails closed with 503, no email sent', async function () {
  cloudflare = 'down';
  const r = await post(GENUINE);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(resendCalls().length, 0);
});

test('handler: Turnstile secret not set fails closed with 503, no email sent', async function () {
  delete process.env.TURNSTILE_SECRET_KEY;
  const r = await post(GENUINE);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(calls.length, 0);
});

test('handler: SEO pitch is quarantined to the review address, not the workshop, and gets no confirmation', async function () {
  process.env.QUOTE_QUARANTINE_TO = 'review@example.com';
  const r = await post(SEO_PITCH);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true }); // the sender sees the normal thank you
  const sent = resendCalls();
  assert.strictEqual(sent.length, 1);
  const held = sent[0].payload;
  assert.deepStrictEqual(held.to, ['review@example.com']);
  assert.match(held.subject, /^\[SPAM REVIEW score \d+\] New quote request – RankHigh Ltd$/);
  assert.match(held.text, /NOT sent to the workshop inbox/);
  assert.match(held.html, /background:#fff3cd/);
  assert.strictEqual(held.reply_to, 'mark@rankhigh.example');
});

test('handler: with no review address set, a quarantined pitch goes to the normal inbox marked for review', async function () {
  const r = await post(SEO_PITCH);
  assert.strictEqual(r.status, 200);
  const sent = resendCalls();
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].payload.to, ['workshop@example.com']);
  assert.match(sent[0].payload.subject, /^\[SPAM REVIEW score/);
  assert.match(sent[0].payload.text, /normal inbox/);
});

test('handler: if the quarantine email fails the sender is told it did not send', async function () {
  process.env.QUOTE_QUARANTINE_TO = 'review@example.com';
  resendFails = true;
  const r = await post(SEO_PITCH);
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.ok, false);
});
