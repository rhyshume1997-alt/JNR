'use strict';
// Local demo for looking at the real pages in a browser: real handlers, real Postgres, fake storage, fake Buffer.
// Not part of the site and not run by the tests. Usage: TEST_DATABASE_URL=... node testlib/demo.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./harness');

(async () => {
  const db = await H.createTestDb();
  const s3 = await H.startFakeS3(); const buf = await H.startFakeBuffer();
  H.setEnv(s3, buf);
  process.env.PUBLIC_MEDIA_BASE_URL = s3.endpoint + '/public-media';
  const auth = require('../api/_lib/auth');
  for (const [role, email] of [['admin', 'admin@jnr.test'], ['editor', 'editor@jnr.test'], ['workshop', 'work@jnr.test']]) await auth.createUser({ email: 'seed' }, { email, name: role[0].toUpperCase() + role.slice(1), role, password: 'correct horse battery staple' });
  const admin = require('../api/admin'); const pub = require('../api/public');
  const root = path.join(__dirname, '..', '..');
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/admin')) return admin(req, res);
    if (p.startsWith('/our-work') || p === '/api/feed') return pub(req, res);
    let f = p === '/' ? '/index.html' : p;
    if (!path.extname(f)) f = (f.endsWith('/') ? f : f + '/') + 'index.html';
    const full = path.join(root, f);
    if (!full.startsWith(root) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[path.extname(full)] || 'application/octet-stream' }); fs.createReadStream(full).pipe(res);
  });
  await new Promise((r) => server.listen(Number(process.env.PORT || 4173), '127.0.0.1', r));
  console.log('DEMO http://127.0.0.1:' + server.address().port + '  buffer=' + buf.url + ' db=' + db.name);
  process.on('SIGTERM', async () => { server.close(); await db.drop(); process.exit(0); });
  global.__buf = buf;
})();
