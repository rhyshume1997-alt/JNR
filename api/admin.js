'use strict';

// Internal JSON API behind sign-in. One function (Vercel Hobby allows 12) with a small router.
// Everything under /api/admin/*. Roles: workshop < editor < admin.

const { HttpError, send, sendError, readJson, assertSameOrigin, clientIp } = require('./_lib/http');
const auth = require('./_lib/auth');
const E = require('./_lib/entries');
const P = require('./_lib/publish');
const M = require('./_lib/model');
const caption = require('./_lib/caption');
const guide = require('./_lib/writing-guide');
const ai = require('./_lib/ai-caption');
const tolra = require('./_lib/tolra');
const { query } = require('./_lib/db');
const { getConfig } = require('./_lib/config');

const ID = '([0-9a-f-]{36})';
const R = [];
function route(method, path, minRole, fn) { R.push({ method, re: new RegExp('^' + path.replace(/:id/g, ID).replace(/:version/g, '([0-9]{1,6})') + '$'), minRole, fn }); }

function pathOf(req) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams.get('path');
  if (q !== null) return '/' + q.replace(/^\/+|\/+$/g, '');
  return url.pathname.replace(/^\/api\/admin/, '').replace(/\/+$/, '') || '/';
}

// ---- auth
route('POST', '/auth/login', null, async (ctx) => {
  const body = await ctx.body();
  const r = await auth.login(body.email, body.password, clientIp(ctx.req), ctx.req.headers['user-agent']);
  return { status: 200, headers: { 'Set-Cookie': auth.sessionCookie(r.token, r.maxAge) }, body: { user: r.user } };
});
route('POST', '/auth/logout', null, async (ctx) => { await auth.logout(ctx.req); return { status: 200, headers: { 'Set-Cookie': auth.clearCookie() }, body: { ok: true } }; });
route('GET', '/auth/me', 'workshop', async (ctx) => ({ body: { user: ctx.user, stages: M.STAGES.map((s) => ({ id: s, label: M.STAGE_LABELS[s] })), kinds: M.KINDS.map((k) => ({ id: k, label: M.KIND_LABELS[k] })),
  limits: { maxBytes: getConfig().upload.maxBytes, maxPerEntry: getConfig().upload.maxPerEntry }, features: { public_media_is_dev: /\.r2\.dev(\/|$)/i.test(getConfig().storage.publicBaseUrl || ''), ai_captions: getConfig().caption.aiEnabled && !!getConfig().caption.apiKey, tolra: tolra.enabled(), buffer_env: getConfig().buffer.env, linkedin: getConfig().buffer.enabled } } }));

// ---- entries
route('GET', '/entries', 'workshop', async (ctx) => ({ body: { entries: await E.listEntries(ctx.user, { status: ctx.q('status'), q: ctx.q('q'), limit: ctx.q('limit'), offset: ctx.q('offset') }), counts: await E.statusCounts(ctx.user) } }));
route('POST', '/entries', 'workshop', async (ctx) => {
  const r = await E.createEntry(ctx.user, await ctx.body(), ctx.req.headers['idempotency-key']);
  return { status: r.replayed ? 200 : 201, body: { entry: E.viewFor(ctx.user, r.entry), replayed: r.replayed } };
});
route('GET', '/entries/:id', 'workshop', async (ctx, id) => {
  const entry = await E.getEntry(id);
  E.assertCanSee(ctx.user, entry);
  const out = { entry: E.viewFor(ctx.user, entry), images: await E.getImages(id, null, { readyOnly: true }) };
  if (M.hasRole(ctx.user, 'editor')) { out.publications = await P.listPublications(id); out.checks = await E.previewApproval(ctx.user, id); }
  return { body: out };
});
route('PATCH', '/entries/:id', 'workshop', async (ctx, id) => { const r = await E.updateEntry(ctx.user, id, await ctx.body()); return { body: { entry: E.viewFor(ctx.user, r.entry), changed: r.changed } }; });
route('POST', '/entries/:id/submit', 'workshop', async (ctx, id) => ({ body: { entry: E.viewFor(ctx.user, await E.submitEntry(ctx.user, id)) } }));
route('POST', '/entries/:id/approve', 'editor', async (ctx, id) => ({ body: { entry: await E.approveEntry(ctx.user, id, await ctx.body()) } }));
route('POST', '/entries/:id/reject', 'editor', async (ctx, id) => ({ body: { entry: await E.rejectEntry(ctx.user, id, (await ctx.body()).note) } }));
route('POST', '/entries/:id/publish', 'editor', async (ctx, id) => ({ body: await P.publishEntry(ctx.user, id) }));
route('POST', '/entries/:id/unpublish', 'admin', async (ctx, id) => ({ body: { entry: await P.unpublish(ctx.user, id) } }));
route('GET', '/entries/:id/audit', 'editor', async (ctx, id) => ({ body: { audit: await E.entryAudit(ctx.user, id, ctx.q('limit')) } }));
route('PUT', '/entries/:id/images/order', 'workshop', async (ctx, id) => ({ body: { images: await E.setImageOrder(ctx.user, id, (await ctx.body()).order) } }));
route('POST', '/entries/:id/images/presign', 'workshop', async (ctx, id) => ({ status: 201, body: await E.presignImage(ctx.user, id, await ctx.body()) }));
route('POST', '/entries/:id/caption', 'editor', async (ctx, id) => {
  const entry = await E.getEntry(id);
  const body = await ctx.body();
  const out = await caption.generateCaption(entry, { provider: body.provider === 'ai' ? 'ai' : body.provider === 'template' ? 'template' : undefined });
  if (body.save === true) {
    await E.updateEntry(ctx.user, id, { caption: out.caption });
    await query('update entries set caption_source = $2 where id = $1', [id, out.source]);
  }
  return { body: out };
});
// AI-written LinkedIn post draft: returns text for a person to edit and approve. Never saves, schedules or publishes anything.
route('POST', '/entries/:id/ai-caption', 'editor', async (ctx, id) => ({ body: await ai.generate(ctx.user, id, E, await ctx.body()) }));
route('POST', '/entries/:id/stage-suggestion', 'editor', async (ctx, id) => {
  const entry = await E.getEntry(id);
  return { body: { suggestion: entry.job_ref ? await tolra.suggestStage(entry.job_ref) : null } };
});

// ---- images
route('POST', '/images/:id/finalize', 'workshop', async (ctx, id) => ({ body: { image: await E.finalizeImage(ctx.user, id) } }));
route('PATCH', '/images/:id', 'workshop', async (ctx, id) => ({ body: { image: await E.updateImage(ctx.user, id, await ctx.body()) } }));
route('DELETE', '/images/:id', 'workshop', async (ctx, id) => { await E.deleteImage(ctx.user, id); return { body: { ok: true } }; });
route('GET', '/images/:id/preview', 'workshop', async (ctx, id) => ({ raw: await E.previewImage(ctx.user, id), type: 'image/jpeg' }));

// ---- publications
route('POST', '/publications/:id/resolve', 'editor', async (ctx, id) => ({ body: await P.resolveUncertain(ctx.user, id, await ctx.body()) }));

// ---- writing guide (editors and admins): the voice and examples used for AI-written LinkedIn posts
route('GET', '/writing-guide', 'editor', async () => ({ body: Object.assign(await guide.getGuide(), { history: await guide.guideHistory(20), limits: guide.LIMITS }) }));
route('PUT', '/writing-guide', 'editor', async (ctx) => ({ body: await guide.saveGuide(ctx.user, await ctx.body()) }));
route('POST', '/writing-guide/restore/:version', 'editor', async (ctx, version) => ({ body: await guide.restoreVersion(ctx.user, version) }));
route('POST', '/entries/:id/style-example', 'editor', async (ctx, id) => ({ status: 201, body: await guide.addPublishedExample(ctx.user, id) }));

// ---- users (admin)
route('GET', '/users', 'admin', async () => ({ body: { users: (await query('select id, email, name, role, disabled, created_at from users order by created_at')).rows } }));
route('POST', '/users', 'admin', async (ctx) => ({ status: 201, body: { user: await auth.createUser(ctx.user, await ctx.body()) } }));
route('PATCH', '/users/:id', 'admin', async (ctx, id) => {
  const b = await ctx.body();
  if (id === ctx.user.id && (b.disabled === true || (b.role && b.role !== 'admin'))) throw new HttpError(409, 'self_lockout', 'You cannot disable or demote your own account.');
  const sets = []; const vals = [id];
  if (b.role !== undefined) { if (!M.ROLES.includes(b.role)) throw new HttpError(422, 'validation', 'Unknown role.'); vals.push(b.role); sets.push('role = $' + vals.length); }
  if (b.disabled !== undefined) { vals.push(b.disabled === true); sets.push('disabled = $' + vals.length); }
  if (b.password !== undefined) { const p = auth.passwordProblem(b.password); if (p) throw new HttpError(422, 'validation', p); vals.push(await auth.hashPassword(b.password)); sets.push('password_hash = $' + vals.length); sets.push('failed_attempts = 0', 'locked_until = null'); }
  if (!sets.length) throw new HttpError(422, 'validation', 'Nothing to change.');
  const { rows } = await query('update users set ' + sets.join(', ') + ' where id = $1 returning id', vals);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'User not found.');
  if (b.disabled === true || b.password !== undefined) await query('delete from sessions where user_id = $1', [id]);
  await auth.audit(null, ctx.user, 'user_updated', null, { user_id: id, fields: Object.keys(b).filter((k) => k !== 'password').concat(b.password !== undefined ? ['password'] : []) });
  return { body: { ok: true } };
});

module.exports = async function handler(req, res) {
  try {
    assertSameOrigin(req);
    const path = pathOf(req);
    const url = new URL(req.url, 'http://x');
    let found = null; let pathMatched = false;
    for (const r of R) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method === req.method) { found = { r, m }; break; }
    }
    if (!found) return pathMatched ? send(res, 405, { error: 'method_not_allowed', message: 'Method not allowed.' }) : send(res, 404, { error: 'not_found', message: 'Not found.' });
    const ctx = { req, q: (k) => url.searchParams.get(k) || undefined, body: () => readJson(req), user: null };
    if (found.r.minRole) ctx.user = await auth.requireUser(req, found.r.minRole);
    const out = await found.r.fn(ctx, found.m[1]);
    if (out.raw) return send(res, 200, out.raw, { 'Content-Type': out.type, 'Cache-Control': 'private, max-age=300' });
    return send(res, out.status || 200, out.body, out.headers);
  } catch (e) { return sendError(res, e); }
};
module.exports.pathOf = pathOf;
