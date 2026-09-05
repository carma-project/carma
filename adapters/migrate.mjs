// Versioned, idempotent migration runner. Applies adapters/migrations/*.sql in
// filename order, tracking applied versions in a schema_migrations table.
// Usage: DATABASE_URL=... node adapters/migrate.mjs
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

// Match the server's SSL handling (server/config.js) so migrations work against
// managed Postgres (Railway/RDS) reached over TLS. 'disable' (default) |
// 'require' (encrypt, don't verify CA) | 'verify' (verify CA).
const sslMode = (process.env.DATABASE_SSL || 'disable').toLowerCase();
const ssl = sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify' };

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl });

// Serialize migrations across concurrent instances (e.g. rolling deploys) with
// a session-level advisory lock on a fixed key.
const LOCK_KEY = 776_1001;

try {
  await pool.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const applied = new Set(
    (await pool.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
  );
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log('skip   ', file);
      continue;
    }
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('applied', file);
      count++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('failed ', file, '-', e.message);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  console.log(`migrations complete (${count} applied, ${files.length} total)`);
} finally {
  try {
    await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  } catch {
    /* lock is released on disconnect regardless */
  }
  await pool.end();
}
