'use strict';
// Static wiring: navigation, sitemap, rewrites, headers and the prepared redirect. No database needed.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { activate } = require('../scripts/activate-our-work-redirect');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const vercel = JSON.parse(read('vercel.json'));
const pages = ['index.html', 'about.html', 'services.html', 'quote.html', 'privacy.html', 'thanks.html', '404.html', 'team.html', 'work.html', 'projects/index.html',
  'capabilities/materials.html', 'capabilities/cnc-milling.html', 'capabilities/cnc-turning.html', 'capabilities/prototypes.html', 'capabilities/batch-production.html'];

describe('site wiring', () => {
  it('has no public Our Work menu link in the nav, mobile menu or footer of any existing page (the gallery is not offered)', () => {
    for (const p of pages) {
      const h = read(p);
      assert.ok(!/id="nl-work"/.test(h), p + ' nav');
      assert.ok(!/href="\/our-work"/.test(h.match(/<div class="mobile-menu"[\s\S]*?<\/div>/)[0]), p + ' mobile');
      assert.ok(!/href="\/our-work"/.test(h.match(/<div class="foot-h">Site<\/div>[\s\S]*?<\/ul>/)[0]), p + ' footer');
    }
  });
  it('routes the new pages, feed and sitemap to the public function and the admin API to the admin function', () => {
    const rw = Object.fromEntries(vercel.rewrites.map((r) => [r.source, r.destination]));
    assert.strictEqual(rw['/our-work'], '/api/public?view=index');
    assert.strictEqual(rw['/our-work/:slug'], '/api/public?view=entry&slug=:slug');
    assert.strictEqual(rw['/api/feed'], '/api/public?view=feed');
    assert.strictEqual(rw['/sitemap-work.xml'], '/api/public?view=sitemap');
    assert.strictEqual(rw['/api/admin/:path*'], '/api/admin?path=:path*');
  });
  it('lists the dynamic sitemap in robots.txt and leaves the static sitemap untouched', () => {
    assert.match(read('robots.txt'), /Sitemap: https:\/\/jnrengineering\.co\.uk\/sitemap-work\.xml/);
    assert.ok(!read('sitemap.xml').includes('our-work'), 'static sitemap does not list an empty page');
  });
  it('keeps /admin and /workshop out of search, uncached, unframed and under a strict content policy', () => {
    const h = vercel.headers.find((x) => x.source.includes('admin'));
    const get = (k) => h.headers.find((x) => x.key === k).value;
    assert.match(get('X-Robots-Tag'), /noindex/); assert.strictEqual(get('Cache-Control'), 'no-store'); assert.strictEqual(get('X-Frame-Options'), 'DENY');
    assert.match(get('Content-Security-Policy'), /script-src 'self'/);
    assert.match(get('Content-Security-Policy'), /connect-src 'self' https:\/\/\*\.r2\.cloudflarestorage\.com;/, 'uploads may only go to Cloudflare R2, not any https host');
    assert.ok(!/unsafe-inline|unsafe-eval/.test(get('Content-Security-Policy').replace("style-src 'self' https://fonts.googleapis.com", '')), 'no unsafe script policy');
    for (const f of ['admin/index.html', 'workshop/index.html', 'post/index.html']) { assert.match(read(f), /noindex/); assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(read(f)), f + ' has no inline script'); assert.ok(!/ style="/.test(read(f)), f + ' has no inline style'); }
  });
  it('does not keep the old /projects redirect active yet (prepared only)', () => {
    const sources = vercel.redirects.map((r) => r.source);
    assert.ok(!sources.includes('/projects') && !sources.includes('/projects/'));
    assert.deepStrictEqual(vercel.redirects.find((r) => r.source === '/work'), { source: '/work', destination: '/projects/', statusCode: 301 });
  });
  it('the prepared redirect, once activated, sends /projects and /work straight to /our-work and is idempotent', () => {
    const on = activate(vercel);
    const map = Object.fromEntries(on.redirects.map((r) => [r.source, r]));
    for (const s of ['/projects', '/projects/', '/work']) { assert.strictEqual(map[s].destination, '/our-work'); assert.strictEqual(map[s].statusCode, 301); }
    assert.deepStrictEqual(activate(on), on);
    assert.deepStrictEqual(on.rewrites, vercel.rewrites, 'nothing else is touched');
  });
});
