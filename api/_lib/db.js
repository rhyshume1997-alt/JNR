'use strict';

const { Pool } = require('pg');
const { getConfig } = require('./config');

let pool = null;
let poolUrl = null;

function getPool() {
  const url = getConfig().databaseUrl;
  if (!url) throw Object.assign(new Error('DATABASE_URL is not set'), { status: 503, code: 'not_configured' });
  if (!pool || poolUrl !== url) {
    if (pool) pool.end().catch(function () {});
    // Serverless: keep the pool tiny. Use the provider's pooled connection string.
    pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000,
      ssl: /localhost|127\.0\.0\.1|\/tmp|host=/.test(url) || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false } });
    poolUrl = url;
  }
  return pool;
}

function query(text, params) { return getPool().query(text, params); }

// Runs fn(client) inside one transaction. Rolls back on any error.
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    try { await client.query('rollback'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) { const p = pool; pool = null; poolUrl = null; await p.end(); }
}

module.exports = { query, tx, closePool, getPool };
