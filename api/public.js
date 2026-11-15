'use strict';

// Public, read-only pages: /our-work, /our-work/:slug and /api/feed. Reads only entries that have an approved,
// published live_snapshot. Cached at the edge so the database is not hit on every view.

const { query } = require('./_lib/db');
const { send } = require('./_lib/http');
const render = require('./_lib/render');

const CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';

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
    else view = 'index';
  }
  const html = (status, body, cache) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache || CACHE });
  try {
    if (view === 'feed') {
      const items = render.feedItems(await liveEntries(3));
      return send(res, 200, { items }, { 'Cache-Control': CACHE, 'Access-Control-Allow-Origin': '*' });
    }
    if (view === 'entry') {
      if (!/^[a-z0-9-]{1,80}$/.test(String(slug || ''))) return html(404, render.renderNotFound(), 'public, max-age=0, s-maxage=30');
      const { rows } = await query('select slug, live_snapshot from entries where slug = $1 and live_snapshot is not null', [slug]);
      const row = rows[0];
      if (!row || !(row.live_snapshot.is_case_study && row.live_snapshot.body)) return html(404, render.renderNotFound(), 'public, max-age=0, s-maxage=30');
      return html(200, render.renderEntry(row));
    }
    return html(200, render.renderIndex(await liveEntries(60)));
  } catch (e) {
    console.error('public page error:', e && e.stack || e);
    // Never show a broken page: the site still works without this section.
    return html(503, render.renderIndex([]).replace('New work will be added here soon.', 'This page is having a problem. Please try again shortly.'), 'no-store');
  }
};
