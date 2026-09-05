import http from 'http';
import url from 'url';
import { readFileSync } from 'fs';
import { importSPKI } from 'jose';
import { verifyCapability } from './middleware/jwt.js';
import { enforceCapability, sanitizeUri } from './middleware/guardrails.js';
import { embed, toVectorLiteral } from './embedding.js';
import { storeTrace, newTraceUri } from './ingest.js';
import { PostgresAdapter } from '../adapters/postgres.js';

const PORT = process.env.PORT || 7100;
const PUBLIC_KEY_PEM = process.env.PUBLIC_KEY || '';
const PRIVATE_KEY_PEM = process.env.PRIVATE_KEY || '';
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

function readJsonBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limitBytes) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Verify the bearer capability token and enforce it for (uri, action).
// Returns the JWT payload on success; throws on any failure.
async function authorize(req, uri, action) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) throw new Error('Missing token');
  if (!publicKey) throw new Error('Server missing PUBLIC_KEY');
  const claims = await verifyCapability(token, publicKey);
  enforceCapability(claims, uri, action);
  return claims;
}

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
      privateKey: { configured: Boolean(PRIVATE_KEY_PEM) },
      database: { configured: Boolean(DATABASE_URL), connected: false, schemaReady: false },
      rag: { ready: false },
    };
    if (DATABASE_URL) {
      try {
        const r = await adapter.check();
        status.database.connected = r.connected;
        status.database.schemaReady = r.schemaReady;
        status.rag.ready = r.ragReady;
      } catch (e) {
        status.database.error = e.message;
      }
    }
    status.ready =
      status.publicKey.valid &&
      status.privateKey.configured &&
      status.database.connected &&
      status.database.schemaReady &&
      status.rag.ready;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  // Resolve a JSON-AM envelope by URI (read capability required).
  if (parsed.pathname === '/resolve' && req.method === 'GET') {
    let uri;
    try {
      uri = sanitizeUri(parsed.query.uri);
      await authorize(req, uri, 'read');
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

  // Ingest a reasoning trace: signed JSON-AM trace:// envelope + RAG index entry
  // (write capability required).
  if (parsed.pathname === '/memory' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    const trustDomain = body.trustDomain || TRUST_DOMAIN;
    if (!trustDomain) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'trustDomain not set (body.trustDomain or TRUST_DOMAIN)' }));
      return;
    }
    const uri = body.uri ? sanitizeUri(body.uri) : newTraceUri(trustDomain);
    let claims;
    try {
      claims = await authorize(req, uri, 'write');
    } catch (e) {
      res.writeHead(403);
      res.end('Forbidden: ' + e.message);
      return;
    }
    try {
      const result = await storeTrace(
        adapter,
        { uri, trustDomain, subject: claims.sub, privateKeyPem: PRIVATE_KEY_PEM },
        body
      );
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('ingest error:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Semantic search over stored memories/traces (read capability required).
  // Returns JSON-AM pointers ranked by similarity.
  if (parsed.pathname === '/search' && req.method === 'GET') {
    const q = parsed.query.q;
    const domain = parsed.query.domain || TRUST_DOMAIN;
    const k = Math.min(Number(parsed.query.k) || 5, 50);
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing query parameter q' }));
      return;
    }
    try {
      await authorize(req, `memory://${domain}/search`, 'read');
    } catch (e) {
      res.writeHead(403);
      res.end('Forbidden: ' + e.message);
      return;
    }
    try {
      const embedding = toVectorLiteral(await embed(String(q)));
      const results = await adapter.search({ embedding, k, trustDomain: domain || null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ query: q, count: results.length, results }));
    } catch (e) {
      console.error('search error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`CARMA listening on ${PORT}`));
