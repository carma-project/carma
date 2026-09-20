// Versioned, idempotent migration runner. Applies adapters/migrations/*.sql in
// filename order, tracking applied versions in a schema_migrations table.
// Usage: DATABASE_URL=... node adapters/migrate.mjs
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pg from 'pg';
import { normalizeDbSslMode, dbSslConfig } from '../server/dbssl.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

// The same DATABASE_SSL handling as the server (server/config.js), so the
// boot-time migration and the process that follows it never disagree on TLS.
const sslMode = normalizeDbSslMode(process.env.DATABASE_SSL);
if (!sslMode.valid) console.error(`DATABASE_SSL="${sslMode.raw}" invalid (disable | require | verify); failing closed to "require".`);
const ssl = dbSslConfig(sslMode.mode);

const connectTimeoutRaw = Number(process.env.DB_CONNECT_TIMEOUT_MS);
const connectionTimeoutMillis = Number.isFinite(connectTimeoutRaw) && connectTimeoutRaw > 0 ? connectTimeoutRaw : 5000;

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl, connectionTimeoutMillis, max: 1 });

// Serialize migrations across concurrent instances (e.g. rolling deploys) with
// a session-level advisory lock on a fixed key. Lock and unlock must run on the
// same session, so one dedicated client is used throughout.
const LOCK_KEY = 776_1001;

// The image CMD chains this script before the server; a Postgres that is still
// starting, failing over, or not yet resolvable in the first seconds of the
// container's life must not crash the container into a restart loop.
async function connectWithRetry(attempts = 8) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const client = await pool.connect();
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
      return client;
    } catch (e) {
      lastError = e;
      const wait = Math.min(1000 * 2 ** i, 15000);
      console.error(`database not ready (${e.message}); retry ${i + 1}/${attempts} in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

let client;
try {
  client = await connectWithRetry();
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log('skip   ', file);
      continue;
    }
    const sql = readFileSync(path.join(dir, file), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('applied', file);
      count++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('failed ', file, '-', e.message);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) console.log(`migrations complete (${count} applied, ${files.length} total)`);
} catch (e) {
  console.error('migration runner failed:', e.message);
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch {
      /* lock is released on disconnect regardless */
    }
    client.release();
  }
  await pool.end();
}
