'use strict';

// Public, read-only pages: /our-work, /our-work/:slug and /api/feed. Reads only entries that have an approved,
// published live_snapshot. Cached at the edge so the database is not hit on every view.

const { query } = require('./_lib/db');
const { send } = require('./_lib/http');
const render = require('./_lib/render');

// Nothing public is cached for the first launch: when an entry is taken off the website it is gone from the next request. (A short edge
// cache can be reintroduced later together with an explicit purge on unpublish.)
const CACHE = 'no-store';

async function liveEntries(limit) {
  const { rows } = await query('select slug, live_at, live_snapshot from entries where live_snapshot is not null order by (live_snapshot->>\'event_date\') desc, live_at desc limit $1', [limit]);
  return rows;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
  const url = new URL(req.url, 'http://x');
  let view = url.searchParams.get('view');
  let slug = url.searchParams.get('slug');
  if (!view) {
    const m = url.pathname.match(/^\/our-work\/([^/]+)\/?$/);
    if (m) { view = 'entry'; slug = decodeURIComponent(m[1]); }
    else if (/^\/api\/feed\/?$/.test(url.pathname)) view = 'feed';
    else if (/^\/sitemap-work\.xml$/.test(url.pathname)) view = 'sitemap';
    else view = 'index';
  }
  const html = (status, body, cache) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache || CACHE });
  try {
    if (view === 'feed') {
      const items = render.feedItems(await liveEntries(3));
      return send(res, 200, { items }, { 'Cache-Control': CACHE, 'Access-Control-Allow-Origin': '*' });
    }
    if (view === 'sitemap') {
      // Lists /our-work and case studies only once something is published, so an empty (noindex) page is never in a sitemap.
      const rows = await liveEntries(200);
      const site = require('./_lib/config').getConfig().siteUrl;
      const esc = render.esc;
      const urls = rows.length ? [site + '/our-work'].concat(rows.filter((r) => r.live_snapshot.is_case_study && r.live_snapshot.body).map((r) => site + '/our-work/' + encodeURIComponent(r.slug))) : [];
      const lastmod = rows.length ? new Date(rows[0].live_at).toISOString().slice(0, 10) : null;
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.map((u) => '  <url><loc>' + esc(u) + '</loc>' + (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') + '</url>').join('\n') + '\n</urlset>\n';
      return send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': CACHE });
    }
    if (view === 'entry') {
      if (!/^[a-z0-9-]{1,80}$/.test(String(slug || ''))) return html(404, render.renderNotFound(), 'no-store');
      const { rows } = await query('select slug, live_snapshot from entries where slug = $1 and live_snapshot is not null', [slug]);
      const row = rows[0];
      if (!row || !(row.live_snapshot.is_case_study && row.live_snapshot.body)) return html(404, render.renderNotFound(), 'no-store');
      return html(200, render.renderEntry(row));
    }
    return html(200, render.renderIndex(await liveEntries(60)));
  } catch (e) {
    console.error('public page error:', e && e.stack || e);
    // Never show a broken page or the wrong content type: answer in the format that was asked for, and never cache a failure.
    if (view === 'feed') return send(res, 503, { items: [], error: 'unavailable' }, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    if (view === 'sitemap') return send(res, 503, '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n', { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return html(503, render.renderIndex([]).replace('New work will be added here soon.', 'This page is having a problem. Please try again shortly.'), 'no-store');
  }
};
