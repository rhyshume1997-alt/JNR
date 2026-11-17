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
  let db, s3, buf, fake, site, browser, tmp, photos, dbq;
  const jsErrors = [];

  before(async () => {
    db = await H.createTestDb(); s3 = await H.startFakeS3(); buf = await H.startFakeBuffer(); fake = await H.startFakeAnthropic(); H.setEnv(s3, buf);
    process.env.PUBLIC_MEDIA_BASE_URL = s3.endpoint + '/public-media';
    dbq = require('../api/_lib/db').query;
    const auth = require('../api/_lib/auth');
    for (const [role, email] of [['admin', 'admin@jnr.test'], ['editor', 'editor@jnr.test'], ['editor', 'editor2@jnr.test'], ['workshop', 'work@jnr.test'], ['workshop', 'other@jnr.test']]) await auth.createUser({ email: 'seed' }, { email, name: role, role, password: PW });
    site = await require('../testlib/site-server').startSite(0, { extraConnectSrc: s3.endpoint }); // the fake storage is plain http; real R2 is https and is already allowed
    browser = await chromium.launch();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jnr-e2e-'));
    photos = [];
    for (let i = 0; i < 3; i++) { const f = path.join(tmp, 'photo' + i + '.jpg'); fs.writeFileSync(f, await H.jpegWithExif(1800 + i * 50, 1200, ['#2b4b9e', '#556b2f', '#8a4b2b'][i])); photos.push(f); }
    fs.writeFileSync(path.join(tmp, 'drawing.pdf'), H.FAKE_PDF);
  });
  after(async () => { await browser.close(); await site.close(); await s3.close(); await buf.close(); await fake.close(); await db.drop(); fs.rmSync(tmp, { recursive: true, force: true }); });

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
  async function signIn2(p, email, title) {
    await p.evaluate(() => fetch('/api/admin/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'jnr' } }));
    await signIn(p, '/admin', email); await p.waitForSelector('.list .item');
    await p.locator('.list .item', { hasText: title }).click(); await p.waitForSelector('.order');
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
      await p.check('#d-li'); await p.click('button:has-text("Free template")'); await p.waitForSelector('text=Caption made from the job details');
      assert.match(await p.inputValue('#f-caption'), /Completed: Flange batch from the phone/);
      assert.ok(!(await p.inputValue('#f-caption')).includes('Zeta'));
      await p.click('button:has-text("Approve")'); await p.waitForSelector('text=Someone else needs to approve this');   // independent approval: the caption was written here
      const c2 = await ctx('desktop'); const p2 = await page(c2, 'editor2');
      await signIn(p2, '/admin', 'editor2@jnr.test'); await p2.waitForSelector('.list .item');
      await p2.locator('.list .item', { hasText: 'Flange batch from the phone' }).click(); await p2.waitForSelector('.order');
      await p2.click('button:has-text("Approve")'); await p2.waitForSelector('text=Approved. Public photo copies');
      await p2.click('button:has-text("Publish")'); await p2.waitForSelector('text=Published. Website: published. LinkedIn: draft saved in Buffer and checked. Nothing was posted.');
      await c2.close();
      const post = [...buf.state.posts.values()].pop();
      assert.strictEqual(post.status, 'draft'); assert.strictEqual(post.assets.length, 2);
      const imgIds = (await dbq("select approved_snapshot->'images' as i from entries where title = 'Flange batch from the phone'")).rows[0].i.map((i) => i.id);
      const wanted = order.map((s) => s.split('/images/')[1].split('/')[0]);
      assert.deepStrictEqual(imgIds, wanted, 'the order chosen in the dashboard is the order published');
      await c.close();
    });
    it('publishing to the website only says so, says LinkedIn was not selected, and sends nothing to Buffer', async () => {
      const c = await ctx('desktop'); const p = await page(c, 'editor3');
      const w = await ctx('phone'); const wp = await page(w, 'phone3');
      await signIn(wp, '/workshop', 'work@jnr.test'); await fillForm(wp, 'Website only job', [photos[2]]); await wp.click('button.big'); await wp.waitForSelector('text=Saved', { timeout: 30000 });
      await signIn(p, '/admin', 'editor@jnr.test'); await p.waitForSelector('.list .item');
      await p.locator('.list .item', { hasText: 'Website only job' }).click(); await p.waitForSelector('.order');
      await p.locator('.order input[type=checkbox]').first().check(); await p.waitForTimeout(400);
      assert.strictEqual(await p.isChecked('#d-li'), false, 'LinkedIn is not selected');
      await p.click('button:has-text("Approve")'); await p.waitForSelector('text=Approved.');
      const drafts = buf.state.posts.size;
      await p.click('button:has-text("Publish")'); await p.waitForSelector('text=Published. Website: published.');
      const banner = await p.locator('.notice').first().innerText();
      assert.match(banner, /LinkedIn: not selected, nothing was sent to Buffer\./);
      assert.ok(!/draft saved/i.test(banner), banner);
      assert.strictEqual(buf.state.posts.size, drafts, 'no Buffer draft was created');
      await c.close(); await w.close();
    });
    it('a published entry that goes back to draft is clearly marked "Still live on website"; LinkedIn can be switched off', async () => {
      const c = await ctx('desktop'); const p = await page(c, 'editor4');
      await signIn(p, '/admin', 'editor@jnr.test'); await p.waitForSelector('.list .item');
      await p.locator('.list .item', { hasText: 'Website only job' }).click(); await p.waitForSelector('.order');
      assert.strictEqual(await p.locator('#still-live').count(), 0, 'no warning while it is simply published');
      assert.match(await p.locator('.pill.live').first().innerText(), /Live on website/i);
      await p.fill('#f-summary', 'Reworded after publishing, not yet approved.');
      await p.click('button:has-text("Save changes")');
      await p.waitForSelector('#still-live');
      assert.match(await p.locator('#still-live').innerText(), /Still live on website/i);
      assert.match(await p.locator('.pill.live').first().innerText(), /Still live on website/i);
      assert.match(await p.locator('.pill.draft').first().innerText(), /Draft/i);
      await p.click('button:has-text("Back to list")'); await p.waitForSelector('.list .item');
      assert.match(await p.locator('.list .item', { hasText: 'Website only job' }).innerText(), /still live on website/i);
      // the public site still shows the last approved wording
      const feed = await (await fetch(site.origin + '/api/feed')).json();
      assert.ok(feed.items.some((i) => i.title === 'Website only job'), 'still public');
      // LinkedIn switched off: no tick box, a plain message instead, and the page still works
      const was = process.env.LINKEDIN_ENABLED; process.env.LINKEDIN_ENABLED = 'false';
      try {
        await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForSelector('.list .item');   // the page reads the site's features once, when it loads
        await p.locator('.list .item', { hasText: 'Website only job' }).click(); await p.waitForSelector('#li-off');
        assert.strictEqual(await p.locator('#d-li').count(), 0, 'no LinkedIn tick box');
        assert.match(await p.locator('#li-off').innerText(), /switched off/i);
      } finally { if (was === undefined) delete process.env.LINKEDIN_ENABLED; else process.env.LINKEDIN_ENABLED = was; }
      await c.close();
    });
    it('a photo that cannot be uploaded leaves nothing behind and does not block the retry on the phone', async () => {
      const w = await ctx('phone'); const wp = await page(w, 'phone4');
      let blockPut = true;
      await w.route((u) => u.href.startsWith(s3.endpoint), (r) => (blockPut && r.request().method() === 'PUT' ? r.abort('failed') : r.continue()));
      await signIn(wp, '/workshop', 'work@jnr.test'); await fillForm(wp, 'Weak signal job', [photos[0]]); await wp.click('button.big');
      await wp.waitForSelector('text=did not upload', { timeout: 60000 });
      const id = (await dbq("select id from entries where title = 'Weak signal job'")).rows[0].id;
      assert.strictEqual((await dbq("select count(*)::int n from entry_images where entry_id = $1", [id])).rows[0].n, 0, 'the failed upload was removed again');
      blockPut = false;
      await wp.click('button.big'); await wp.waitForSelector('text=Sent to the office for approval', { timeout: 30000 });
      assert.deepStrictEqual((await dbq("select state from entry_images where entry_id = $1", [id])).rows.map((r) => r.state), ['ready']);
      assert.strictEqual((await dbq("select status from entries where id = $1", [id])).rows[0].status, 'pending_approval');
      await w.close();
    });
    it('shows a failed Buffer step clearly and recovers with Retry publishing', async () => {
      const c = await ctx('desktop'); const p = await page(c, 'editor2');
      const w = await ctx('phone'); const wp = await page(w, 'phone2');
      await signIn(wp, '/workshop', 'work@jnr.test'); await fillForm(wp, 'Buffer failure job', [photos[1]]); await wp.click('button.big'); await wp.waitForSelector('text=Saved', { timeout: 30000 });
      await signIn(p, '/admin', 'editor@jnr.test'); await p.waitForSelector('.list .item');
      await p.locator('.list .item', { hasText: 'Buffer failure job' }).click(); await p.waitForSelector('.order');
      await p.locator('.order input[type=checkbox]').first().check(); await p.waitForTimeout(400);
      await p.check('#d-li'); await p.click('button:has-text("Free template")'); await p.waitForSelector('text=Caption made from the job details');
      await signIn2(p, 'editor2@jnr.test', 'Buffer failure job');   // a second editor approves: this one wrote the caption
      await p.click('button:has-text("Approve")'); await p.waitForSelector('text=Approved.');
      buf.state.mode = 'mutation-error'; buf.state.failures = 1;
      await p.click('button:has-text("Publish")'); await p.waitForSelector('text=Not everything finished.');
      assert.match(await p.locator('.notice').first().innerText(), /Website: published\. LinkedIn: did not finish/);
      assert.match(await p.locator('.log').first().innerText(), /failed/i); assert.match(await p.locator('main').innerText(), /Channel is disconnected/);
      assert.strictEqual(await p.locator('.pill.failed').count() >= 1, true);
      buf.state.mode = 'ok';
      await p.click('button:has-text("Retry publishing")'); await p.waitForSelector('text=Published. Website: published. LinkedIn: draft saved in Buffer and checked');
      await c.close(); await w.close();
    });
  });

  describe('AI-written posts', () => {
    const aiOn = () => { Object.assign(process.env, { AI_CAPTIONS_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-browser-test', ANTHROPIC_API_URL: fake.url, AI_USER_DAILY_LIMIT: '50', AI_DAILY_LIMIT: '500', AI_MONTHLY_LIMIT: '5000' }); };
    const aiOff = () => { for (const k of ['AI_CAPTIONS_ENABLED', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_URL', 'AI_USER_DAILY_LIMIT', 'AI_DAILY_LIMIT', 'AI_MONTHLY_LIMIT']) delete process.env[k]; };
    async function phoneEntry(title, notes) {
      const w = await ctx('phone'); const wp = await page(w, 'phone-ai');
      await signIn(wp, '/workshop', 'work@jnr.test'); await fillForm(wp, title, [photos[0]]);
      await wp.fill('#rough', notes); await noOverflow(wp);
      await wp.click('button.big'); await wp.waitForSelector('text=Saved', { timeout: 30000 }); await w.close();
    }
    it('the workshop form has one friendly box for the job in their own words, and nothing else needed', async () => {
      const w = await ctx('phone'); const wp = await page(w, 'phone-box');
      await signIn(wp, '/workshop', 'work@jnr.test'); await wp.waitForSelector('#rough');
      assert.match(await wp.locator('label[for=rough]').innerText(), /in your own words/i);
      assert.match(await wp.locator('#rough ~ .hint, label[for=rough] ~ .hint').first().innerText(), /microphone/i);
      await noOverflow(wp); await w.close();
    });
    it('with the kill switch off there are no AI buttons anywhere', async () => {
      aiOff(); await phoneEntry('Switch off job', 'Turned a run of brackets.');
      const c = await ctx('desktop'); const p = await page(c, 'editor-off');
      await signIn(p, '/admin', 'editor@jnr.test'); await p.waitForSelector('.list .item');
      await p.locator('.list .item', { hasText: 'Switch off job' }).click(); await p.waitForSelector('#f-caption');
      assert.strictEqual(await p.locator('#ai-go').count(), 0); assert.strictEqual(await p.locator('button:has-text("Generate with AI")').count(), 0);
      assert.ok(await p.locator('button:has-text("Free template")').count() >= 1);
      await c.close();
    });
    it('an editor generates a draft, edits it, regenerates, and saves; nothing is posted; blocked text explains itself; the writing guide can be edited', async () => {
      aiOn(); fake.state.calls.length = 0; fake.state.replies.length = 0;
      await phoneEntry('Brackets for the boat', 'Made a run of brackets for a boat builder. The thin wall was the tricky bit so we took light cuts.');
      const c = await ctx('desktop'); const p = await page(c, 'editor-ai');
      await signIn(p, '/admin', 'editor@jnr.test'); await p.waitForSelector('.list .item');
      await p.locator('.list .item', { hasText: 'Brackets for the boat' }).click(); await p.waitForSelector('#ai-go');
      assert.match(await p.locator('#ai-go').innerText(), /Generate with AI/);
      // first draft
      fake.state.reply = JSON.stringify({ post: 'We made a run of brackets for a boat builder. The thin wall was the tricky bit, so we took light cuts.', questions: [] });
      await p.click('#ai-go'); await p.waitForSelector('#ai-out .notice.ok');
      assert.match(await p.inputValue('#f-caption'), /light cuts/);
      assert.match(await p.locator('#ai-out').innerText(), /Nothing is saved or posted until you do/); assert.match(await p.locator('#ai-out').innerText(), /1 of 50/);
      assert.match(await p.locator('#ai-go').innerText(), /Regenerate/);
      assert.ok(!(await dbq("select caption from entries where title = 'Brackets for the boat'")).rows[0].caption, 'the draft is not saved yet');
      // edit it by hand, then regenerate with an instruction: the second draft replaces the box
      await p.fill('#f-caption', 'My own edit that will be replaced.');
      fake.state.reply = JSON.stringify({ post: 'Brackets for a boat builder, with light cuts on the thin wall.', questions: [] });
      await p.fill('#ai-instr', 'make it shorter'); await p.click('#ai-go'); await p.waitForFunction(() => /Brackets for a boat builder/.test(document.querySelector('#f-caption').value));
      assert.match(fake.state.calls[1].body.messages[0].content, /make it shorter/);
      // edit and save
      await p.fill('#f-caption', 'Brackets for a boat builder, with light cuts on the thin wall. Checked by the office.');
      await p.click('button:has-text("Save changes")'); await p.waitForSelector('text=Saved.');
      assert.match((await dbq("select caption from entries where title = 'Brackets for the boat'")).rows[0].caption, /Checked by the office/);
      assert.strictEqual(buf.state.posts.size >= 0, true);
      assert.ok(![...buf.state.posts.values()].some((x) => /Brackets for a boat builder/.test(x.text || '')), 'nothing was sent to Buffer');
      // blocked: the customer's name typed into the notes
      await p.fill('#f-rough_notes', 'Made brackets for Zeta Hydraulics.'); await p.fill('#f-customer_name', 'Zeta Hydraulics');
      const before = fake.state.calls.length; await p.click('#ai-go'); await p.waitForSelector('#ai-out .notice.bad');
      assert.match(await p.locator('#ai-out').innerText(), /customer's name is in the job notes[\s\S]*Nothing was sent to the AI/i);
      assert.strictEqual(fake.state.calls.length, before, 'nothing left the building');
      // the writing guide page
      await p.click('button:has-text("Back to list")'); await p.waitForSelector('#guide-btn'); await p.click('#guide-btn'); await p.waitForSelector('#g-style');
      assert.match(await p.inputValue('#g-length'), /one short paragraph/i);
      await p.fill('#g-signoff', 'Got a job to make? Send us the drawing.'); await p.check('#g-signdefault');
      await p.click('#g-save'); await p.waitForSelector('text=Saved as version 1.');
      assert.strictEqual((await dbq("select version from settings where key = 'writing_guide'")).rows[0].version, 1);
      await p.click('button:has-text("Back")'); await p.waitForSelector('.list .item');
      await c.close(); aiOff();
    });
    it('a limit is explained in plain words and the free template stays available', async () => {
      aiOn(); process.env.AI_USER_DAILY_LIMIT = '1'; await dbq("delete from audit_log where action = 'ai_caption_requested'");
      await phoneEntry('Limit job', 'Made a run of brackets for a boat builder.');
      const c = await ctx('desktop'); const p = await page(c, 'editor-limit');
      await signIn(p, '/admin', 'editor2@jnr.test'); await p.waitForSelector('.list .item');
      await p.locator('.list .item', { hasText: 'Limit job' }).click(); await p.waitForSelector('#ai-go');
      fake.state.reply = JSON.stringify({ post: 'We made a run of brackets for a boat builder.', questions: [] });
      await p.click('#ai-go'); await p.waitForSelector('#ai-out .notice.ok');
      await p.click('#ai-go'); await p.waitForSelector('#ai-out .notice.warn');
      assert.match(await p.locator('#ai-out').innerText(), /used your 1 AI drafts for today[\s\S]*free template is still available/i);
      assert.ok(await p.locator('button:has-text("Free template")').count() >= 1);
      await c.close(); aiOff();
    });
  });

  describe('the one-page post tool', () => {
    const aiOn = () => { Object.assign(process.env, { AI_CAPTIONS_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-browser-test', ANTHROPIC_API_URL: fake.url, AI_USER_DAILY_LIMIT: '50', AI_DAILY_LIMIT: '500', AI_MONTHLY_LIMIT: '5000' }); };
    const aiOff = () => { for (const k of ['AI_CAPTIONS_ENABLED', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_URL', 'AI_USER_DAILY_LIMIT', 'AI_DAILY_LIMIT', 'AI_MONTHLY_LIMIT']) delete process.env[k]; };
    it('John uploads photos, adds notes, generates, edits, and saves ONE Buffer draft that is not scheduled or posted', async () => {
      aiOn(); fake.state.calls.length = 0; fake.state.replies.length = 0;
      const c = await ctx('desktop'); const p = await page(c, 'post-admin');
      await signIn(p, '/post', 'admin@jnr.test'); await p.waitForSelector('#p-title');
      await p.fill('#p-title', 'Quick post bracket run');
      await p.fill('#p-notes', 'Made a run of brackets for a boat builder. Thin wall was tricky so light cuts.');
      await p.setInputFiles('#p-file', [photos[0], photos[1]]); await p.waitForFunction(() => document.querySelectorAll('#p-photos img').length === 2, null, { timeout: 30000 });
      fake.state.reply = JSON.stringify({ post: 'We made a run of brackets for a boat builder. The thin wall was the tricky bit, so we took light cuts.', questions: [] });
      await p.click('#p-gen'); await p.waitForSelector('#p-ai .notice.ok');
      assert.match(await p.inputValue('#p-caption'), /light cuts/);
      await p.fill('#p-caption', (await p.inputValue('#p-caption')) + ' Edited by John.');
      // photos must be ticked as checked first
      await p.click('#p-save'); await p.waitForSelector('#p-msg .notice.bad');
      assert.match(await p.locator('#p-msg').innerText(), /checked the photos/);
      const before = buf.state.posts.size; assert.strictEqual(before >= 0, true);
      await p.check('#p-check'); await p.click('#p-save'); await p.waitForSelector('#p-result .notice.ok');
      assert.match(await p.locator('#p-result').innerText(), /Saved in Buffer as a draft\. Nothing has been posted/);
      const post = [...buf.state.posts.values()].pop();
      assert.strictEqual(post.status, 'draft'); assert.strictEqual(post.assets.length, 2); assert.match(post.text, /Edited by John/);
      assert.ok(!post.dueAt && !post.scheduledAt, 'not scheduled');
      assert.strictEqual(buf.state.posts.size, before + 1, 'exactly one draft');
      const e = (await dbq("select status, destinations from entries where title = 'Quick post bracket run'")).rows[0];
      assert.strictEqual(e.status, 'published'); assert.strictEqual(e.destinations.website, false);
      assert.ok((await dbq("select 1 from audit_log where action = 'ai_caption_requested'")).rows.length >= 1, 'audit record kept');
      // a second press of Save does not make a second draft
      await p.click('#p-another'); assert.strictEqual(await p.inputValue('#p-title'), '');
      assert.strictEqual(buf.state.posts.size, before + 1);
      await noOverflow(p); await c.close();
    });
    it('a workshop update shows under "Waiting for you", John finishes it from the one page; workshop staff cannot use the page', async () => {
      aiOff();
      const w = await ctx('phone'); const wp = await page(w, 'post-phone');
      await signIn(wp, '/workshop', 'work@jnr.test'); await fillForm(wp, 'Staff sent update', [photos[2]]); await wp.click('button.big'); await wp.waitForSelector('text=Saved', { timeout: 30000 });
      await wp.goto(site.origin + '/post', { waitUntil: 'domcontentloaded' }); await wp.waitForSelector('text=This page is for John and the office');
      assert.strictEqual(await wp.locator('#p-save').count(), 0); await w.close();
      const c = await ctx('desktop'); const p = await page(c, 'post-admin2');
      await signIn(p, '/post', 'admin@jnr.test'); await p.waitForSelector('#p-waiting .card');
      assert.match(await p.locator('#p-waiting').innerText(), /Staff sent update/);
      await p.locator('#p-waiting .card.row', { hasText: 'Staff sent update' }).locator('button:has-text("Open")').click();
      await p.waitForFunction(() => document.querySelectorAll('#p-photos img').length === 1);
      assert.ok(await p.locator('#p-ai-off').count() === 1, 'AI is off so the page says so');
      await p.click('#p-gen'); await p.waitForFunction(() => document.querySelector('#p-caption').value.length > 20);
      await p.check('#p-check'); const before = buf.state.posts.size; assert.strictEqual(await p.locator('#p-web').count(), 0, 'no website tick on this page'); await p.click('#p-save'); await p.waitForSelector('#p-result .notice.ok');
      assert.strictEqual(buf.state.posts.size, before + 1);
      const e = (await dbq("select status, destinations from entries where title = 'Staff sent update'")).rows[0];
      assert.strictEqual(e.status, 'published'); assert.strictEqual(e.destinations.website, false, 'nothing goes to the website from this page');
      await c.close();
    });
    it('a "tolerance" warning can be ticked and the post is then written (tick-then-generate)', async () => {
      aiOn(); fake.state.calls.length = 0;
      const c = await ctx('desktop'); const p = await page(c, 'post-ack');
      await signIn(p, '/post', 'admin@jnr.test'); await p.waitForSelector('#p-title');
      await p.fill('#p-title', 'Stainless brackets for a boat builder'); await p.fill('#p-notes', 'Stainless brackets. Tight tolerances on the bore.');
      fake.state.reply = JSON.stringify({ post: 'We made stainless brackets for a boat builder, with a carefully held bore.', questions: [] });
      await p.click('#p-gen'); await p.waitForSelector('#p-ai .notice.warn');
      assert.match(await p.locator('#p-ai').innerText(), /tolerance/i); assert.strictEqual(fake.state.calls.length, 0, 'nothing sent before the tick');
      await p.click('#p-gen'); await p.waitForSelector('#p-ai .notice.warn'); assert.strictEqual(fake.state.calls.length, 0, 'an unticked box does not count');
      await p.check('#p-ai input[type=checkbox]'); await p.click('#p-gen'); await p.waitForSelector('#p-ai .notice.ok');
      assert.match(await p.inputValue('#p-caption'), /stainless brackets/i); assert.ok(fake.state.calls.length >= 1);
      await c.close(); aiOff();
    });
    it('John can schedule: opt-in, UK time, a separate confirm step, Cancel sends nothing, Buffer gets a scheduled post (not a draft, not post-now)', async () => {
      aiOn(); fake.state.rawQueue = []; fake.state.rawContent = null;
      const ukLocal = (ms) => { const q = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).forEach((x) => { q[x.type] = x.value; }); return q.year + '-' + q.month + '-' + q.day + 'T' + q.hour + ':' + q.minute; };
      const when = ukLocal(Date.now() + 3 * 24 * 3600 * 1000 + 3600 * 1000);
      const c = await ctx('desktop'); const p = await page(c, 'post-schedule');
      await signIn(p, '/post', 'admin@jnr.test'); await p.waitForSelector('#p-title');
      assert.strictEqual(await p.locator('#p-web').count(), 0); assert.ok(!(await p.isVisible('#p-when')), 'scheduling is off until asked for');
      assert.match(await p.locator('#p-save').innerText(), /Save as LinkedIn draft/);
      await p.fill('#p-title', 'Scheduled bracket run'); await p.fill('#p-notes', 'Made a run of brackets for a boat builder.');
      await p.setInputFiles('#p-file', [photos[0]]); await p.waitForFunction(() => document.querySelectorAll('#p-photos img').length === 1, null, { timeout: 30000 });
      await p.fill('#p-caption', 'We made a run of brackets for a boat builder this week.'); await p.check('#p-check');
      const before = buf.state.posts.size;
      await p.check('#p-sched'); assert.ok(await p.isVisible('#p-when')); assert.match(await p.locator('#p-save').innerText(), /Review and schedule/);
      await p.click('#p-save'); await p.waitForSelector('#p-msg .notice.bad'); assert.match(await p.locator('#p-msg').innerText(), /Pick a date and time/);
      await p.fill('#p-when-input', '2020-01-01T09:00'); await p.click('#p-save'); await p.waitForSelector('#p-msg .notice.bad'); assert.match(await p.locator('#p-msg').innerText(), /at least 5 minutes/);
      await p.fill('#p-when-input', when); await p.click('#p-save'); await p.waitForSelector('#p-confirm-yes');
      assert.match(await p.locator('#p-confirm').innerText(), /Schedule this post for .*\(UK time\)\?/); assert.match(await p.locator('#p-confirm').innerText(), /Nothing is posted now/);
      assert.strictEqual(buf.state.posts.size, before, 'nothing is sent before the confirmation');
      await p.click('#p-confirm-no'); assert.strictEqual(await p.locator('#p-confirm-yes').count(), 0); assert.strictEqual(buf.state.posts.size, before, 'Cancel sends nothing');
      await p.click('#p-save'); await p.click('#p-confirm-yes'); await p.waitForSelector('#p-result .notice.ok');
      assert.match(await p.locator('#p-result').innerText(), /Scheduled in Buffer for .*\(UK time\)\. Nothing has been posted yet/);
      assert.strictEqual(buf.state.posts.size, before + 1); const post = [...buf.state.posts.values()].pop();
      assert.strictEqual(post.status, 'scheduled'); assert.strictEqual(ukLocal(new Date(post.dueAt).getTime()), when, 'the time Buffer holds is the UK time that was typed');
      const input = buf.state.calls.filter((x) => /createPost/.test(x.query)).pop().variables.input; assert.strictEqual(input.mode, 'customScheduled'); assert.strictEqual(input.saveToDraft, false);
      await noOverflow(p); await c.close(); aiOff();
    });
    it('an editor does not see the schedule option; a draft is still the default there', async () => {
      const c = await ctx('desktop'); const p = await page(c, 'post-editor');
      await signIn(p, '/post', 'editor@jnr.test'); await p.waitForSelector('#p-title');
      assert.strictEqual(await p.locator('#p-sched').count(), 0); assert.match(await p.locator('#p-save').innerText(), /Save as LinkedIn draft/); await c.close();
    });
    it('is usable on a phone and shows a blocked AI request in plain words', async () => {
      aiOn();
      const c = await ctx('phone'); const p = await page(c, 'post-phone-admin');
      await signIn(p, '/post', 'admin@jnr.test'); await p.waitForSelector('#p-title'); await noOverflow(p);
      await p.fill('#p-title', 'Private detail brackets'); await p.fill('#p-notes', 'Made brackets. Contact the buyer on buyer@example.com about them.');
      const calls = fake.state.calls.length;
      await p.click('#p-gen'); await p.waitForSelector('#p-ai .notice.bad');
      assert.match(await p.locator('#p-ai').innerText(), /Nothing was sent to the AI/);
      assert.strictEqual(fake.state.calls.length, calls, 'nothing left the building');
      await noOverflow(p); await c.close(); aiOff();
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
