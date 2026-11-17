'use strict';
// A local copy of the whole site for browser tests and demos: static files, the API handlers, and the security headers
// from vercel.json (so a Content-Security-Policy mistake shows up in the browser, as it would in production).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain' };

function headerRules() {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  return (v.headers || []).map((h) => ({ re: new RegExp('^' + h.source.replace(/\(\.\*\)/g, '.*') + '$'), headers: h.headers }));
}

async function startSite(port, opts) {
  const extraConnect = (opts && opts.extraConnectSrc) || '';
  const admin = require('../api/admin'); const pub = require('../api/public');
  const rules = headerRules();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/admin')) return admin(req, res);
    if (p.startsWith('/our-work') || p === '/api/feed' || p === '/sitemap-work.xml') return pub(req, res);
    let f = p === '/' ? '/index.html' : p;
    // Like Vercel's cleanUrls: /name serves name.html, /dir/ serves dir/index.html
    if (!path.extname(f)) f = !f.endsWith('/') && fs.existsSync(path.join(root, f + '.html')) ? f + '.html' : (f.endsWith('/') ? f : f + '/') + 'index.html';
    const full = path.join(root, f);
    if (!full.startsWith(root) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
    const h = { 'content-type': types[path.extname(full)] || 'application/octet-stream' };
    rules.forEach((r) => { if (r.re.test(p)) r.headers.forEach((x) => { h[x.key] = x.key === 'Content-Security-Policy' && extraConnect ? x.value.replace("connect-src 'self'", "connect-src 'self' " + extraConnect) : x.value; }); });
    res.writeHead(200, h); fs.createReadStream(full).pipe(res);
  });
  await new Promise((r) => server.listen(port || 0, '127.0.0.1', r));
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
}
module.exports = { startSite };
