'use strict';
// Full end-to-end run against REAL services (Postgres, Cloudflare R2, Buffer), using this site's own handlers.
//
//   What it does: creates three throw-away users and one clearly named test entry, uploads two generated photos (with fake
//   GPS and camera data) through the real signed-upload flow, generates a caption, approves, publishes, then checks:
//     - the Buffer draft exists, status "draft", no schedule, same caption, same two image URLs, in order
//     - each public image URL is fetchable by anyone, is a JPEG, and has no EXIF/GPS
//     - private markers (customer, job reference, internal notes, original file name) appear nowhere public
//   What it never does: schedule or publish to LinkedIn (drafts only, staging channel only), or touch real entries.
//   Cleanup order (so nothing is ever left pointing at deleted images): (1) the test draft is deleted from Buffer and confirmed
//   gone, (2) only then the public and private photos, (3) the test entry and users. If the draft cannot be deleted (or its id
//   is unknown after a lost reply), the public photos are KEPT so the draft still shows its images, and you get exact
//   instructions to delete the draft in Buffer and then the photos. The delete only ever targets the one draft this run
//   created, and only if it is still an unscheduled draft on the staging channel carrying this run's unique marker.
//
//   NOT A TEST OF THE DEPLOYED PREVIEW: this runs this repository's handlers on the computer you run it from, against the real
//   Postgres, R2 and Buffer. The protected Vercel preview is tested separately (docs/WORKSHOP-SETUP.md, "Test the protected
//   preview"), which also proves the variables on Vercel, serverless-to-database access and browser uploads from that address.
//   Use synthetic photographs only: the public bucket's r2.dev address is readable by anyone with the link.
//
//   Never touches production: refuses unless DEPLOY_ENV/BUFFER_ENV are "staging" and the bucket names contain "staging"; never
//   contacts Vercel; only creates and deletes rows it created itself (throw-away users on @staging-e2e.invalid and one entry).
//
//   BUFFER_ENV must be "staging". Pass --confirm-draft to allow creating the one test draft in Buffer; without it the run
//   covers everything except the Buffer step. --selftest runs the whole script against local fakes.
const crypto = require('node:crypto');
const sharp = require('sharp');
const { assertStagingTarget, describeTargets } = require('./lib/guard');

const rows = []; let failures = 0;
const rec = (tag, name, detail) => { if (tag === 'FAIL') failures++; rows.push({ tag, name, detail }); console.log((tag + '    ').slice(0, 5) + ' ' + name + (detail ? '  -  ' + detail : '')); };
const check = (cond, name, detail) => rec(cond ? 'PASS' : 'FAIL', name, cond ? undefined : detail);

async function run(opts) {
  const H = require('../testlib/harness');
  const { getConfig } = require('../api/_lib/config');
  const { query } = require('../api/_lib/db');
  const auth = require('../api/_lib/auth');
  const { storage } = require('../api/_lib/s3');
  const B = require('../api/_lib/buffer');
  const cfg = getConfig();
  if (cfg.buffer.env !== 'staging') throw new Error('Refusing to run: BUFFER_ENV must be "staging".');
  if (cfg.caption.aiEnabled) throw new Error('Refusing to run: AI captions are enabled (paid API). Unset AI_CAPTIONS_ENABLED.');

  const tag = 'e2e' + crypto.randomBytes(4).toString('hex');
  const MARK = { customer: 'CUSTOMER-' + tag, job: 'JOBREF-' + tag, notes: 'PRIVATE-NOTES-' + tag, file: 'ORIGINAL-' + tag + '.jpg' };
  const pw = crypto.randomBytes(18).toString('base64url') + 'aA1';
  const mail = (r) => r + '-' + tag + '@staging-e2e.invalid';
  const app = await H.startApp();
  const ids = { users: [], entry: null, privateKeys: [], publicKeys: [], draftId: null, draftMarker: 'Staging test ' + tag, draftUnknown: false };
  try {
    for (const role of ['workshop', 'editor', 'admin']) ids.users.push((await auth.createUser({ email: 'staging-e2e' }, { email: mail(role), name: 'E2E ' + role, role, password: pw })).id);
    const work = app.client(), editor = app.client();
    check((await work.login(mail('workshop'), pw)).status === 200 && (await editor.login(mail('editor'), pw)).status === 200, 'sign in (workshop, editor)');

    const created = await work.post('/entries', { kind: 'in_production', title: 'Staging test ' + tag, summary: 'Test entry from the staging check. Please ignore.', material: 'Aluminium 6082', process: 'CNC milling', stage: 'machining',
      customer_name: MARK.customer, job_ref: MARK.job, customer_notes: MARK.notes }, { 'idempotency-key': crypto.randomUUID() });
    check(created.status === 201, 'workshop creates entry', JSON.stringify(created.data));
    ids.entry = created.data.entry.id;

    const photos = [];
    for (let i = 0; i < 2; i++) photos.push(await H.jpegWithExif(2000 + i * 100, 1400, i ? '#556b2f' : '#2b4b9e'));
    const imageIds = [];
    for (let i = 0; i < photos.length; i++) {
      const up = await H.uploadImage(work, ids.entry, photos[i], 'image/jpeg', MARK.file);
      check(up.put && up.put.ok && up.finalize.status === 200, 'photo ' + (i + 1) + ': signed upload to storage and server check', up.put ? 'PUT ' + up.put.status + ' ' + JSON.stringify(up.finalize.data) : JSON.stringify(up.presign.data));
      if (up.imageId) { imageIds.push(up.imageId); ids.privateKeys.push('originals/' + ids.entry + '/' + up.imageId); }
    }
    const refused = await H.uploadImage(work, ids.entry, H.FAKE_PDF, 'image/jpeg', 'drawing.jpg');
    check(refused.finalize && refused.finalize.status === 422, 'a drawing disguised as a photo is refused');
    for (const id of imageIds) await editor.patch('/images/' + id, { cleared_for_public: true, alt_text: 'Staging test photograph' });
    await editor.patch('/entries/' + ids.entry, { destinations: { website: true, linkedin: !!opts.draft } });
    const cap = await editor.post('/entries/' + ids.entry + '/caption', { save: true });
    check(cap.data.source === 'template' && /Staging test/.test(cap.data.caption) && !cap.data.caption.includes(MARK.customer), 'free template caption generated, no private data in it');
    check((await work.post('/entries/' + ids.entry + '/submit')).status === 200, 'workshop submits for approval');
    const ap = await editor.post('/entries/' + ids.entry + '/approve', {});
    check(ap.status === 200, 'editor approves', JSON.stringify(ap.data));
    const snap = (await query('select approved_snapshot s from entries where id = $1', [ids.entry])).rows[0].s;
    snap.images.forEach((i) => { ids.publicKeys.push(decodeURIComponent(i.url.slice(cfg.storage.publicBaseUrl.length + 1))); });

    const pub = await editor.post('/entries/' + ids.entry + '/publish');
    if (!opts.draft) {
      check(pub.status === 200 && pub.data.results.length === 1 && pub.data.results[0].status === 'verified', 'website publish (Buffer step skipped: pass --confirm-draft to include it)', JSON.stringify(pub.data));
    } else {
      const li = (pub.data.results || []).find((r) => r.destination === 'linkedin');
      if (li && li.buffer_post_id) ids.draftId = li.buffer_post_id;
      check(pub.status === 200 && li && li.status === 'verified', 'Buffer draft created and verified by the server', JSON.stringify(pub.data.results));
      if (li && li.buffer_post_id) {
        const post = await B.readPost(li.buffer_post_id);
        check(post.status === 'draft', 'Buffer post status is "draft"', post.status);
        check(!post.dueAt && !post.sentAt, 'not scheduled, not sent', 'dueAt=' + post.dueAt + ' sentAt=' + post.sentAt);
        check(post.channelId === cfg.buffer.stagingChannelId, 'on the staging channel only');
        check(post.text.replace(/\r\n/g, '\n').trim() === snap.caption.trim(), 'saved caption matches the approved caption');
        const urls = snap.images.map((i) => i.url);
        const assets = (post.assets || []).filter((a) => a.type === 'image' || !a.type);
        check(assets.length === 2 && assets.every((a, i) => a.source === urls[i]), 'BOTH images are attached to the draft, in order', JSON.stringify(assets.map((a) => a.source)));
        ids.draftId = li.buffer_post_id;
      }
      if (li && !li.buffer_post_id && li.status !== 'verified') ids.draftUnknown = true; // sent but the reply was lost or failed: a draft may exist
    }

    // What the world can see
    const leaks = [];
    const html = await (await fetch(app.origin + '/our-work')).text();
    check(html.includes('Staging test ' + tag), 'the approved entry appears on /our-work');
    const feed = JSON.stringify(await (await fetch(app.origin + '/api/feed')).json());
    const sm = await (await fetch(app.origin + '/sitemap-work.xml')).text();
    for (const v of Object.values(MARK)) for (const [where, text] of [['page', html], ['feed', feed], ['sitemap', sm], ['approved snapshot', JSON.stringify(snap)], ['caption', snap.caption]]) if (text.includes(v)) leaks.push(v + ' in ' + where);
    for (const i of snap.images) {
      const r = await fetch(i.url, { redirect: 'manual' });
      const body = Buffer.from(await r.arrayBuffer());
      const meta = await sharp(body).metadata();
      check(r.status === 200 && /image\/jpeg/.test(r.headers.get('content-type') || ''), 'public image is fetchable by anyone', i.url + ' -> ' + r.status);
      check(!meta.exif && !body.includes(Buffer.from('SECRETCAM')) && !body.includes(Buffer.from('SECRET-OWNER')), 'public image has no EXIF, GPS or camera data');
      if (body.includes(Buffer.from(MARK.file))) leaks.push('original file name in public image');
    }
    check(leaks.length === 0, 'no private marker appears anywhere public (customer, job reference, notes, original file name)', leaks.join('; '));
    const anonPrivate = await fetch(cfg.storage.endpoint.replace(/\/$/, '') + '/' + cfg.storage.privateBucket + '/' + ids.privateKeys[0], { redirect: 'manual' });
    check(anonPrivate.status !== 200, 'the original photo is not publicly readable', 'anonymous GET returned 200');
    check((await work.get('/entries/' + ids.entry + '/audit')).status === 403, 'workshop role cannot read the audit history');
  } finally {
    // ---- Cleanup. Order matters: the draft goes first, so no Buffer draft is ever left pointing at deleted images.
    let keepMedia = false;
    if (ids.draftId) {
      try {
        await B.deleteTestDraft(ids.draftId, { marker: ids.draftMarker, channelId: cfg.buffer.stagingChannelId });
        rec('PASS', 'test draft deleted from Buffer and confirmed gone', ids.draftId);
      } catch (e) {
        keepMedia = true;
        rec('WARN', 'the test draft could NOT be deleted automatically', (e.message || String(e)).slice(0, 160));
      }
    } else if (ids.draftUnknown) {
      keepMedia = true;
      rec('WARN', 'a draft may exist in Buffer but its id is unknown (the reply was lost or the step failed)', 'search Buffer for the text "' + ids.draftMarker + '"');
    }
    try {
      if (keepMedia) {
        rec('WARN', 'public photos KEPT so the remaining draft still shows its images', 'bucket ' + cfg.storage.publicBucket + ', prefix public/' + ids.entry + '/');
        for (const k of ids.privateKeys) await storage.del('privateBucket', k).catch(() => {});
        console.log('\nTO FINISH CLEANING UP BY HAND:\n  1. In Buffer, delete the draft ' + (ids.draftId ? '(post id ' + ids.draftId + ') ' : 'whose text contains "' + ids.draftMarker + '" ') + 'on your personal LinkedIn channel.\n  2. Then in Cloudflare R2, bucket ' + cfg.storage.publicBucket + ', delete the folder public/' + ids.entry + '/ (the staging bucket only holds test photographs).');
      } else {
        for (const k of ids.privateKeys) await storage.del('privateBucket', k).catch(() => {});
        for (const k of ids.publicKeys) await storage.del('publicBucket', k).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    try { if (ids.entry) { await query('delete from audit_log where entry_id = $1', [ids.entry]); await query('delete from entries where id = $1', [ids.entry]); } if (ids.users.length) { await query('delete from audit_log where actor_email like $1', ['%-' + tag + '@staging-e2e.invalid']); await query('delete from users where id = any($1)', [ids.users]); } } catch (e) { console.error('cleanup problem: ' + e.message); }
    await app.close();
  }
}

async function main() {
  const self = process.argv.includes('--selftest');
  const draft = process.argv.includes('--confirm-draft') || self;
  let cleanup = async () => {};
  if (self) {
    const H = require('../testlib/harness');
    const db = await H.createTestDb(); const s3 = await H.startFakeS3(); const buf = await H.startFakeBuffer(); H.setEnv(s3, buf);
    process.env.PUBLIC_MEDIA_BASE_URL = s3.endpoint + '/public-media';
    if (process.env.SELFTEST_DELETE_FAILS) buf.state.deleteMode = 'error'; // proves the photos are kept when the draft cannot be deleted
    cleanup = async () => { await s3.close(); await buf.close(); await db.drop(); };
  }
  if (!self) { try { assertStagingTarget(process.env); } catch (e) { console.error(e.message); process.exit(2); } }
  console.log('Staging end-to-end' + (self ? ' (self-test against local fakes)' : '') + (draft ? '' : ' (no Buffer draft)') + '\n');
  console.log('This runs this repository\'s code on THIS computer against the real services. It does not test the deployed Vercel preview.\nIt will touch:');
  if (!self) describeTargets(process.env).forEach((l) => console.log('  ' + l));
  console.log('Test data: synthetic photographs only; throw-away users and one entry, all deleted at the end.\n');
  try { await run({ draft }); } catch (e) { rec('FAIL', 'run aborted', (e.message || String(e)).replace(/postgres(ql)?:\/\/[^\s]+/g, '<url>')); }
  console.log('\n' + (failures ? failures + ' step(s) FAILED.' : 'All steps passed.'));
  await require('../api/_lib/db').closePool().catch(() => {}); await cleanup();
  process.exit(failures ? 1 : 0);
}
main();
