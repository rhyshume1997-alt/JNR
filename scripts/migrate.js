'use strict';
// Applies db/migrations/*.sql once each, in order. Usage: DATABASE_URL=... npm run migrate
const fs = require('node:fs');
const path = require('node:path');
const { getPool, closePool } = require('../api/_lib/db');

async function migrate() {
  const pool = getPool();
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) { console.log('skip   ' + f); continue; }
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [f]);
      await client.query('commit');
      console.log('apply  ' + f);
    } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  }
}
module.exports = { migrate };
if (require.main === module) migrate().then(() => closePool(), (e) => { console.error(e.message); process.exit(1); });
