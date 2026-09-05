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

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const pool = new pg.Pool({ connectionString: DATABASE_URL });

try {
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
  await pool.end();
}
