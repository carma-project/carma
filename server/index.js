import http from 'http';
import url from 'url';
import { readFileSync } from 'fs';
import { importSPKI } from 'jose';
import { verifyCapability } from './middleware/jwt.js';
import { enforceCapability, sanitizeUri } from './middleware/guardrails.js';
import { PostgresAdapter } from '../adapters/postgres.js';

const PORT = process.env.PORT || 7100;
const PUBLIC_KEY_PEM = process.env.PUBLIC_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const TRUST_DOMAIN = process.env.TRUST_DOMAIN || '';

const UI_HTML = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

// jose's jwtVerify needs a KeyObject for EdDSA, so the raw SPKI PEM supplied
// via the env var must be imported once at startup. Failure to import must not
// crash the process, so /health keeps responding for the platform healthcheck.
let publicKey = null;
if (PUBLIC_KEY_PEM) {
  try {
    publicKey = await importSPKI(PUBLIC_KEY_PEM, 'EdDSA');
  } catch (e) {
    console.error('Failed to import PUBLIC_KEY:', e.message);
  }
}

// The Pool connects lazily, so an empty/unset DATABASE_URL does not fail boot.
const adapter = new PostgresAdapter(DATABASE_URL);

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || '', true);

  if (parsed.pathname === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  // Built-in configuration UI so an operator can confirm the deploy is wired up.
  if (parsed.pathname === '/' || parsed.pathname === '/ui') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(UI_HTML);
    return;
  }

  // Config/readiness diagnostics. Reports booleans only — never secret values.
  if (parsed.pathname === '/api/status' && req.method === 'GET') {
    const status = {
      port: Number(PORT),
      trustDomain: TRUST_DOMAIN || null,
      publicKey: { configured: Boolean(PUBLIC_KEY_PEM), valid: publicKey !== null },
      database: { configured: Boolean(DATABASE_URL), connected: false, schemaReady: false },
    };
    if (DATABASE_URL) {
      try {
        const r = await adapter.check();
        status.database.connected = r.connected;
        status.database.schemaReady = r.schemaReady;
      } catch (e) {
        status.database.error = e.message;
      }
    }
    status.ready =
      status.publicKey.valid && status.database.connected && status.database.schemaReady;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  if (parsed.pathname === '/resolve' && req.method === 'GET') {
    let uri;
    try {
      uri = sanitizeUri(parsed.query.uri);
      const auth = req.headers.authorization || '';
      const token = auth.replace('Bearer ', '');
      if (!token) throw new Error('Missing token');
      if (!publicKey) throw new Error('Server missing PUBLIC_KEY');
      const claims = await verifyCapability(token, publicKey);
      enforceCapability(claims, uri, 'read');
    } catch (e) {
      res.writeHead(403);
      res.end('Forbidden: ' + e.message);
      return;
    }

    try {
      const envelope = await adapter.resolve(uri);
      if (!envelope) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found', id: uri }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope));
    } catch (e) {
      console.error('resolve error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`CARMA listening on ${PORT}`));
