// DATABASE_SSL handling shared by the server (server/config.js) and the
// migration runner (adapters/migrate.mjs), so both sides always agree on
// whether a connection is encrypted. Plain JS with no imports: migrate.mjs runs
// under bare `node` (no tsx).
export const DB_SSL_MODES = ['disable', 'require', 'verify'];

// Normalize a DATABASE_SSL value. Blank means the default ('disable'). An
// unknown value fails closed to 'require' (encrypted, CA not verified): silently
// downgrading a typo such as "required" or "true" to plaintext would send
// credentials and memory content in the clear.
export function normalizeDbSslMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const mode = raw === '' ? 'disable' : raw;
  const valid = DB_SSL_MODES.includes(mode);
  return { mode: valid ? mode : 'require', valid, raw: mode };
}

// node-postgres `ssl` option for a normalized mode.
export function dbSslConfig(mode) {
  return mode === 'disable' ? false : { rejectUnauthorized: mode === 'verify' };
}
