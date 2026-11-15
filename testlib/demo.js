'use strict';
// Local demo for looking at the real pages in a browser: real handlers, real Postgres, fake storage, fake Buffer.
// Not part of the site and not run by the tests. Usage: TEST_DATABASE_URL=... node testlib/demo.js
const H = require('./harness');

(async () => {
  const db = await H.createTestDb();
  const s3 = await H.startFakeS3(); const buf = await H.startFakeBuffer();
  H.setEnv(s3, buf);
  process.env.PUBLIC_MEDIA_BASE_URL = s3.endpoint + '/public-media';
  const auth = require('../api/_lib/auth');
  for (const [role, email] of [['admin', 'admin@jnr.test'], ['editor', 'editor@jnr.test'], ['workshop', 'work@jnr.test']]) await auth.createUser({ email: 'seed' }, { email, name: role[0].toUpperCase() + role.slice(1), role, password: 'correct horse battery staple' });
  const site = await require('./site-server').startSite(Number(process.env.PORT || 4173));
  const server = { close: () => site.close(), address: () => ({ port: new URL(site.origin).port }) };
  console.log('DEMO http://127.0.0.1:' + server.address().port + '  buffer=' + buf.url + ' db=' + db.name);
  process.on('SIGTERM', async () => { server.close(); await db.drop(); process.exit(0); });
  global.__buf = buf;
})();
