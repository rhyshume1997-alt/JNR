'use strict';
// Real-browser tests (Chromium via Playwright) of the whole site: the phone form, the dashboard, permissions, failure
// recovery, and what the public pages show. Runs the real handlers and real Postgres with fake storage and Buffer.
//   TEST_DATABASE_URL=postgres://... npm run test:browser      (needs: npm i -D playwright, or a preinstalled Chromium)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const H = require('../testlib/harness');

let chromium = null;
try { chromium = require('playwright').chromium; } catch (_) { /* optional */ }
const SKIP = !H.BASE ? 'set TEST_DATABASE_URL' : !chromium ? 'playwright is not installed' : false;
const PW = 'correct horse battery staple';

describe('browser tests', { skip: SKIP }, () => {
  let db, s3, buf, site, browser, tmp, photos, dbq;
  const jsErrors = [];

  before(async () => {
    db = await H.createTestDb(); s3 = await H.startFakeS3(); buf = await H.startFakeBuffer(); H.setEnv(s3, buf);
    process.env.PUBLIC_MEDIA_BASE_URL = s3.endpoint + '/public-media';
    dbq = require('../api/_lib/db').query;
    const auth = require('../api/_lib/auth');
    for (const [role, email] of [['admin', 'admin@jnr.test'], ['editor', 'editor@jnr.test'], ['workshop', 'work@jnr.test'], ['workshop', 'other@jnr.test']]) await auth.createUser({ email: 'seed' }, { email, name: role, role, password: PW });
    site = await require('../testlib/site-server').startSite(0, { extraConnectSrc: s3.endpoint }); // the fake storage is plain http; real R2 is https and is already allowed
    browser = await chromium.launch();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jnr-e2e-'));
    photos = [];
    for (let i = 0; i < 3; i++) { const f = path.join(tmp, 'photo' + i + '.jpg'); fs.writeFileSync(f, await H.jpegWithExif(1800 + i * 50, 1200, ['#2b4b9e', '#556b2f', '#8a4b2b'][i])); photos.push(f); }
    fs.writeFileSync(path.join(tmp, 'drawing.pdf'), H.FAKE_PDF);
  });
  after(async () => { await browser.close(); await site.close(); await s3.close(); await buf.close(); await db.drop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  async function ctx(kind) {
    const c = await browser.newContext(kind === 'phone' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    await c.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    return c;
  }
  async function page(c, label) {
    const p = await c.newPage();
    p.on('pageerror', (e) => jsErrors.push(label + ': ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) jsErrors.push(label + ' CSP: ' + m.text()); });
    return p;
  }
  async function signIn(p, path_, email) {
    await p.goto(site.origin + path_, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#li-email'); await p.fill('#li-email', email); await p.fill('#li-pw', PW); await p.click('form.login button[type=submit]');
  }
  const noOverflow = async (p) => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scrolling');

  async function fillForm(p, title, files, extra) {
    await p.waitForSelector('#title');
    await p.click('label[for=k-completed]');
    await p.fill('#title', title); await p.fill('#summary', 'Batch turned and drilled, checked before it left the workshop.');
    await p.fill('#material', '316 stainless steel'); await p.fill('#process', 'CNC turning');
    if (extra && extra.customer) { await p.click('summary'); await p.fill('#customer', extra.customer); await p.fill('#jobref', extra.jobref); await p.fill('#notes', extra.notes); }
    if (files && files.length) await p.setInputFiles('#photos', files);
  }

  describe('test-mode notice for the r2.dev public address', () => {
    it('warns staff on the form and the dashboard to use test photographs only, and is absent otherwise', async () => {
      const real = process.env.PUBLIC_MEDIA_BASE_URL;
      const c = await ctx('desktop'); const p = await page(c, 'notice');
      await signIn(p, '/workshop', 'editor@jnr.test'); await p.waitForSelector('#title');
      assert.strictEqual(await p.locator('#dev-media-notice').count(), 0, 'no notice for a normal media address');
      process.env.PUBLIC_MEDIA_BASE_URL = 'https://pub-0a1b2c3d4e5f.r2.dev';
      await p.reload(); await p.waitForSelector('#dev-media-notice');
      assert.match(await p.locator('#dev-media-notice').innerText(), /test photographs only/i);
      await p.goto(site.origin + '/admin', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#dev-media-notice');
      process.env.PUBLIC_MEDIA_BASE_URL = real;
      await c.close();
    });
  });

  describe('phone form', () => {
    it('records a job with photos on a phone-sized screen, with no sideways scrolling', async () => {
      const c = await ctx('phone'); const p = await page(c, 'phone');
      await signIn(p, '/workshop', 'work@jnr.test');
      await fillForm(p, 'Flange batch from the phone', [photos[0], photos[1]], { customer: 'Zeta Hydraulics', jobref: 'ZH-9001', notes: 'phone Dave on 07700 900123' });
      await noOverflow(p);
      assert.strictEqual(await p.locator('.photo').count(), 2);
      const box = await p.locator('button.big').boundingBox(); assert.ok(box.height >= 48, 'big tap target');
      await p.click('button.big'); await p.waitForSelector('text=Saved', { timeout: 20000 });
      assert.match(await p.locator('main').innerText(), /Sent to the office for approval/);
      const e = (await dbq("select id, status from entries where title = 'Flange batch from the phone'")).rows;
      assert.strictEqual(e.length, 1); assert.strictEqual(e[0].status, 'pending_approval');
      assert.strictEqual((await dbq('select count(*)::int n from entry_images where entry_id = $1 and state = $2', [e[0].id, 'ready'])).rows[0].n, 2);
      await c.close();
    });
    it('refuses a drawing in the browser before anything is uploaded', async () => {
      const c = await ctx('phone'); const p = await page(c, 'phone');
      await signIn(p, '/workshop', 'work@jnr.test'); await p.waitForSelector('#title');
      await p.setInputFiles('#photos', path.join(tmp, 'drawing.pdf'));
      assert.match(await p.locator('.notice').first().innerText(), /not a photo/);
      assert.strictEqual(await p.locator('.photo').count(), 0);
      await c.close();
    });
  });

  describe('failure recovery', () => {
    it('keeps the entry when one photo upload is interrupted, and a retry sends only the missing photo (no duplicates)', async () => {
      const c = await ctx('phone'); const p = await page(c, 'phone');
      let aborted = 0;
      await p.route(/\/private-originals\//, (route) => { if (route.request().method() === 'PUT' && aborted < 3) { aborted++; return route.abort('connectionreset'); } return route.continue(); });
      await signIn(p, '/workshop', 'work@jnr.test');
      await fillForm(p, 'Interrupted upload job', [photos[0], photos[1]]);
      await p.click('button.big');
      await p.waitForSelector('text=did not upload', { timeout: 30000 });
      assert.ok(aborted >= 1);
      const n = (await dbq("select count(*)::int n from entries where title = 'Interrupted upload job'")).rows[0].n; assert.strictEqual(n, 1, 'entry saved once');
      await p.unroute(/\/private-originals\//);
      await p.click('button.big'); await p.waitForSelector('text=Saved', { timeout: 30000 });
      const e = (await dbq("select id from entries where title = 'Interrupted upload job'")).rows;
      assert.strictEqual(e.length, 1, 'still exactly one entry');
      assert.strictEqual((await dbq("select count(*)::int n from entry_images where entry_id = $1 and state = 'ready'", [e[0].id])).rows[0].n, 2, 'both photos present once each');
      await c.close();
    });
    it('does not create a second entry when the first save request is lost and the person taps again', async () => {
      const c = await ctx('phone'); const p = await page(c, 'phone');
      let first = true;
      await p.route('**/api/admin/entries', async (route) => {
        if (route.request().method() === 'POST' && first) { first = false; await route.fetch(); return route.abort('connectionreset'); } // server processed it, the reply never arrived
        return route.continue();
      });
      await signIn(p, '/workshop', 'work@jnr.test');
      await fillForm(p, 'Lost reply job', [photos[2]]);
      await p.click('button.big'); await p.waitForSelector('.notice.bad', { timeout: 15000 });
      assert.match(await p.locator('.notice.bad').innerText(), /No connection/);
      await p.click('button.big'); await p.waitForSelector('text=Saved', { timeout: 30000 });
      assert.strictEqual((await dbq("select count(*)::int n from entries where title = 'Lost reply job'")).rows[0].n, 1);
      await c.close();
    });
    it('keeps what was typed when the session expires, and carries on after signing in again', async () => {
      const c = await ctx('phone'); const p = await page(c, 'phone');
      await signIn(p, '/workshop', 'work@jnr.test');
      await fillForm(p, 'Session expiry job', [photos[0]]);
      await c.clearCookies();
      await p.click('button.big');
      await p.waitForSelector('text=You were signed out', { timeout: 15000 });
      assert.strictEqual(await p.inputValue('#title'), 'Session expiry job', 'form kept');
      await p.fill('#li-email', 'work@jnr.test'); await p.fill('#li-pw', PW); await p.click('form.login button[type=submit]');
      await p.waitForSelector('text=Signed in');
      await p.click('button.big'); await p.waitForSelector('text=Saved', { timeout: 30000 });
      assert.strictEqual((await dbq("select count(*)::int n from entries where title = 'Session expiry job'")).rows[0].n, 1);
      await c.close();
    });
  });

  describe('dashboard and permissions', () => {
    it('workshop staff see only their own entries, no approve or publish buttons, no Users, and the API refuses them', async () => {
      const c = await ctx('desktop'); const p = await page(c, 'workshop');
      await signIn(p, '/admin', 'other@jnr.test'); await p.waitForSelector('.tabs');
      assert.strictEqual(await p.locator('.list .item').count(), 0, 'other@ has no entries of their own');
      assert.strictEqual(await p.locator('text=Users').count(), 0);
      const w = await ctx('desktop'); const q = await page(w, 'workshop2');
      await signIn(q, '/admin', 'work@jnr.test'); await q.waitForSelector('.list .item');
      await q.locator('.list .item', { hasText: 'Flange batch from the phone' }).click(); await q.waitForSelector('.order');
      assert.strictEqual(await q.locator('button:has-text("Approve")').count(), 0);
      assert.strictEqual(await q.locator('button:has-text("Publish")').count(), 0);
      assert.strictEqual(await q.locator('#d-li').isDisabled(), true, 'destination choice is for editors');
      const codes = await q.evaluate(async () => { const id = location.hash; const r = []; for (const u of ['/api/admin/users']) r.push((await fetch(u, { credentials: 'same-origin' })).status); const post = await fetch('/api/admin/entries/00000000-0000-0000-0000-000000000000/approve', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'jnr', 'Content-Type': 'application/json' }, body: '{}' }); r.push(post.status); return r; });
      assert.deepStrictEqual(codes, [403, 403]);
      await c.close(); await w.close();
    });
    it('shows the login screen to signed-out visitors, and signing out ends the session', async () => {
      const c = await ctx('desktop'); const p = await page(c, 'anon');
      await p.goto(site.origin + '/admin', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#li-email');
      assert.strictEqual(await p.locator('.list').count(), 0);
      await p.fill('#li-email', 'editor@jnr.test'); await p.fill('#li-pw', PW); await p.click('form.login button[type=submit]');
      await p.waitForSelector('.tabs'); await p.click('#out'); await p.waitForSelector('#li-email');
      const status = await p.evaluate(async () => (await fetch('/api/admin/entries', { credentials: 'same-origin' })).status);
      assert.strictEqual(status, 401);
      await c.close();
    });
    it('lets an editor review, tick photos, order them, approve and publish, and shows the Buffer draft as verified', async () => {
      const c = await ctx('desktop'); const p = await page(c, 'editor');
      await signIn(p, '/admin', 'editor@jnr.test'); await p.waitForSelector('.list .item');
      await p.locator('.list .item', { hasText: 'Flange batch from the phone' }).click(); await p.waitForSelector('.order');
      // the customer name etc. are in the private section, not public text; approval is not blocked
      for (let i = 0; i < 2; i++) { await p.locator('.order input[type=checkbox]').nth(i).check(); await p.waitForSelector('.order'); await p.waitForTimeout(250); }
      const firstSrc = await p.locator('.order img').first().getAttribute('src');
      await p.locator('button[aria-label="Move photo down"]').first().click();
      await p.waitForFunction((was) => document.querySelector('.order img') && document.querySelector('.order img').getAttribute('src') !== was, firstSrc);
      const order = await p.locator('.order img').evaluateAll((l) => l.map((x) => x.getAttribute('src')));
      await p.check('#d-li'); await p.click('button:has-text("Generate caption")'); await p.waitForSelector('text=Caption generated');
      assert.match(await p.inputValue('#f-caption'), /Completed: Flange batch from the phone/);
      assert.ok(!(await p.inputValue('#f-caption')).includes('Zeta'));
      await p.click('button:has-text("Approve")'); await p.waitForSelector('text=Approved. Public photo copies');
      await p.click('button:has-text("Publish")'); await p.waitForSelector('text=Published. LinkedIn: draft saved and verified');
      const post = [...buf.state.posts.values()].pop();
      assert.strictEqual(post.status, 'draft'); assert.strictEqual(post.assets.length, 2);
      const imgIds = (await dbq("select approved_snapshot->'images' as i from entries where title = 'Flange batch from the phone'")).rows[0].i.map((i) => i.id);
      const wanted = order.map((s) => s.split('/images/')[1].split('/')[0]);
      assert.deepStrictEqual(imgIds, wanted, 'the order chosen in the dashboard is the order published');
      await c.close();
    });
    it('shows a failed Buffer step clearly and recovers with Retry publishing', async () => {
      const c = await ctx('desktop'); const p = await page(c, 'editor2');
      const w = await ctx('phone'); const wp = await page(w, 'phone2');
      await signIn(wp, '/workshop', 'work@jnr.test'); await fillForm(wp, 'Buffer failure job', [photos[1]]); await wp.click('button.big'); await wp.waitForSelector('text=Saved', { timeout: 30000 });
      await signIn(p, '/admin', 'editor@jnr.test'); await p.waitForSelector('.list .item');
      await p.locator('.list .item', { hasText: 'Buffer failure job' }).click(); await p.waitForSelector('.order');
      await p.locator('.order input[type=checkbox]').first().check(); await p.waitForTimeout(400);
      await p.check('#d-li'); await p.click('button:has-text("Generate caption")'); await p.waitForSelector('text=Caption generated');
      await p.click('button:has-text("Approve")'); await p.waitForSelector('text=Approved.');
      buf.state.mode = 'mutation-error'; buf.state.failures = 1;
      await p.click('button:has-text("Publish")'); await p.waitForSelector('text=Some destinations did not finish');
      assert.match(await p.locator('.log').first().innerText(), /failed/i); assert.match(await p.locator('main').innerText(), /Channel is disconnected/);
      assert.strictEqual(await p.locator('.pill.failed').count() >= 1, true);
      buf.state.mode = 'ok';
      await p.click('button:has-text("Retry publishing")'); await p.waitForSelector('text=Published. LinkedIn');
      await c.close(); await w.close();
    });
  });

  describe('public pages', () => {
    it('shows only published content and never the private details, in the page, the feed or any network request', async () => {
      const c = await ctx('desktop'); const p = await page(c, 'public');
      const urls = []; p.on('request', (r) => urls.push(r.url()));
      await p.goto(site.origin + '/our-work', { waitUntil: 'domcontentloaded' });
      const text = await p.locator('body').textContent(); // textContent: the page upper-cases titles with CSS
      assert.match(text, /Flange batch from the phone/);
      assert.ok(!/Interrupted upload job|Lost reply job|Session expiry job/.test(text), 'entries that were never approved are not shown');
      const html = await p.content();
      for (const secret of ['Zeta Hydraulics', 'ZH-9001', 'Dave', '07700 900123', 'photo0.jpg', 'private-originals', 'originals/']) assert.ok(!html.includes(secret) && !text.includes(secret), 'leaked: ' + secret);
      assert.ok(!urls.some((u) => u.includes('/private-originals/')), 'no request to the private bucket');
      const imgs = await p.locator('.work-photo img').evaluateAll((l) => l.map((i) => ({ src: i.src, ok: i.complete && i.naturalWidth > 0 })));
      assert.ok(imgs.length >= 1 && imgs.every((i) => i.ok && i.src.startsWith(s3.endpoint + '/public-media/public/')), JSON.stringify(imgs));
      const home = await c.newPage(); await home.goto(site.origin + '/', { waitUntil: 'domcontentloaded' }); await home.waitForSelector('#work-feed:not([hidden])', { timeout: 10000 });
      assert.ok(await home.locator('#work-feed .work-card').count() >= 1);
      assert.ok(!(await home.locator('#work-feed').innerText()).includes('Zeta'));
      await c.close();
    });
    it('keeps the public Our Work page usable on a phone', async () => {
      const c = await ctx('phone'); const p = await page(c, 'public-phone');
      await p.goto(site.origin + '/our-work', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('.work-card'); await noOverflow(p);
      await c.close();
    });
  });

  it('had no JavaScript errors or Content-Security-Policy violations anywhere', () => assert.deepStrictEqual(jsErrors, []));
});
