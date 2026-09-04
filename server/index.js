import http from 'http';
import url from 'url';
import { importSPKI } from 'jose';
import { verifyCapability } from './middleware/jwt.js';
import { enforceCapability, sanitizeUri } from './middleware/guardrails.js';
import { PostgresAdapter } from '../adapters/postgres.js';

const PORT = process.env.PORT || 7100;
const PUBLIC_KEY_PEM = process.env.PUBLIC_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

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
