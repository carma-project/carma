import http from 'http';
import url from 'url';
import { readFileSync } from 'fs';
import { importSPKI } from 'jose';
import { verifyCapability } from './middleware/jwt.js';
import { enforceCapability, sanitizeUri, enforceTokenLifetime } from './middleware/guardrails.js';
import { embed, toVectorLiteral } from './embedding.js';
import { storeTrace, newTraceUri } from './ingest.js';
import { runDistillation, fineTuneStatus } from './distill/pipeline.js';
import { PostgresAdapter } from '../adapters/postgres.js';
import { config, redactedSummary } from './config.js';
import { makeLogger, newRequestId } from './logger.js';
import { RateLimiter } from './ratelimit.js';
import { Audit } from './audit.js';

const logger = makeLogger(config.logLevel);
const UI_HTML = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

// jose's jwtVerify needs a KeyObject for EdDSA; import the SPKI PEM once.
// A bad key must not crash the process — /health stays up for orchestration.
let publicKey = null;
if (config.publicKeyPem) {
  try {
    publicKey = await importSPKI(config.publicKeyPem, 'EdDSA');
  } catch (e) {
    logger.error('public_key_import_failed', { error: e.message });
  }
}

const adapter = new PostgresAdapter(config.databaseUrl, {
  ssl: config.dbSslConfig,
  max: config.dbPoolMax,
  idleTimeoutMillis: config.dbIdleTimeoutMs,
  connectionTimeoutMillis: config.dbConnectTimeoutMs,
});
const audit = new Audit(adapter, logger, { enabled: Boolean(config.databaseUrl) });
const limiter = new RateLimiter({ rps: config.rateLimitRps, burst: config.rateLimitBurst });

for (const w of config.warnings) logger.warn('config_warning', { detail: w });
if (config.strictBoot && (!publicKey || !config.privateKeyPem || !config.databaseUrl)) {
  logger.error('strict_boot_failed', { summary: redactedSummary(config) });
  process.exit(1);
}

// ---------- helpers ----------

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (config.hstsEnabled) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

function sendJson(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body);
}

function sendText(res, code, text, extraHeaders = {}) {
  res.writeHead(code, extraHeaders);
  res.end(text);
}

function clientKey(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let data = '';
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      data += chunk;
      if (data.length > limitBytes) {
        aborted = true;
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (aborted) return;
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

// Verify the bearer token, enforce capability + lifetime for (uri, action).
async function authorize(req, uri, action) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) throw new Error('Missing token');
  if (!publicKey) throw new Error('Server missing PUBLIC_KEY');
  const claims = await verifyCapability(token, publicKey);
  enforceTokenLifetime(claims, action, {
    read: config.tokenMaxAgeRead,
    write: config.tokenMaxAgeWrite,
  });
  enforceCapability(claims, uri, action);
  return claims;
}

function domainOf(uri) {
  const parts = String(uri).split('://');
  return parts.length > 1 ? parts[1].split('/')[0] : null;
}

// Rate-limit a request by client key; returns true if it responded with 429.
function rateLimited(req, res, requestId) {
  if (!config.rateLimitEnabled) return false;
  const { allowed, retryAfter } = limiter.take(clientKey(req));
  if (allowed) return false;
  logger.warn('rate_limited', { requestId, client: clientKey(req) });
  sendJson(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(retryAfter) });
  return true;
}

function validateTraceInput(body) {
  const task = body.task ?? null;
  const content = body.content ?? null;
  if (task != null && typeof task !== 'string') throw new Error('task must be a string');
  if (content != null && typeof content !== 'string') throw new Error('content must be a string');
  if (!task && !content) throw new Error('trace requires task or content');
  if ((task || '').length + (content || '').length > config.contentMaxLength) {
    throw new Error('trace content exceeds limit');
  }
  let boundContext = body.boundContext ?? [];
  if (!Array.isArray(boundContext)) throw new Error('boundContext must be an array');
  if (boundContext.length > config.boundContextMax) throw new Error('boundContext too large');
  if (!boundContext.every((x) => typeof x === 'string')) throw new Error('boundContext must be strings');
  return { task, content, boundContext };
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const requestId = newRequestId();
  const started = Date.now();
  const parsed = url.parse(req.url || '', true);
  const path = parsed.pathname || '';
  setSecurityHeaders(res);
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    logger.info('request', {
      requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - started,
    });
  });

  try {
    // Liveness — always 200 while the process is up.
    if (path === '/health') return sendText(res, 200, 'ok');

    // Readiness — 200 only when the server can actually serve requests.
    if (path === '/ready') {
      let ready = publicKey !== null;
      const detail = { publicKey: publicKey !== null, database: false, schema: false };
      if (config.databaseUrl) {
        try {
          const r = await adapter.check();
          detail.database = r.connected;
          detail.schema = r.schemaReady;
          ready = ready && r.connected && r.schemaReady;
        } catch {
          ready = false;
        }
      }
      return sendJson(res, ready ? 200 : 503, { ready, ...detail });
    }

    // Built-in configuration UI.
    if (path === '/' || path === '/ui') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(UI_HTML);
    }

    // Config/readiness diagnostics — booleans only, never secret values.
    if (path === '/api/status' && req.method === 'GET') {
      const status = {
        port: config.port,
        trustDomain: config.trustDomain || null,
        publicKey: { configured: Boolean(config.publicKeyPem), valid: publicKey !== null },
        privateKey: { configured: Boolean(config.privateKeyPem) },
        database: { configured: Boolean(config.databaseUrl), connected: false, schemaReady: false },
        rag: { ready: false },
        audit: { ready: false },
      };
      if (config.databaseUrl) {
        try {
          const r = await adapter.check();
          status.database.connected = r.connected;
          status.database.schemaReady = r.schemaReady;
          status.rag.ready = r.ragReady;
          status.audit.ready = r.auditReady;
        } catch (e) {
          status.database.error = e.message;
        }
      }
      status.ready =
        status.publicKey.valid &&
        status.privateKey.configured &&
        status.database.connected &&
        status.database.schemaReady &&
        status.rag.ready &&
        status.audit.ready;
      return sendJson(res, 200, status);
    }

    // ----- authenticated endpoints (rate-limited) -----

    if (path === '/resolve' && req.method === 'GET') {
      if (rateLimited(req, res, requestId)) return;
      let uri;
      let claims;
      try {
        uri = sanitizeUri(parsed.query.uri);
        claims = await authorize(req, uri, 'read');
      } catch (e) {
        audit.record({ action: 'read', uri: parsed.query.uri, result: 'deny', requestId, detail: { reason: e.message } });
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const envelope = await adapter.resolve(uri);
        audit.record({ actor: claims.sub, action: 'read', uri, trustDomain: domainOf(uri), result: envelope ? 'allow' : 'not_found', requestId });
        if (!envelope) return sendJson(res, 404, { error: 'Not found', id: uri });
        return sendJson(res, 200, envelope);
      } catch (e) {
        logger.error('resolve_error', { requestId, error: e.message });
        return sendJson(res, 500, { error: 'Internal error' });
      }
    }

    if (path === '/memory' && req.method === 'POST') {
      if (rateLimited(req, res, requestId)) return;
      let body;
      try {
        body = await readJsonBody(req, config.bodyLimitBytes);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const trustDomain = body.trustDomain || config.trustDomain;
      if (!trustDomain) return sendJson(res, 400, { error: 'trustDomain not set (body.trustDomain or TRUST_DOMAIN)' });

      let input;
      try {
        input = validateTraceInput(body);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }

      const uri = body.uri ? sanitizeUri(body.uri) : newTraceUri(trustDomain);
      let claims;
      try {
        claims = await authorize(req, uri, 'write');
      } catch (e) {
        audit.record({ action: 'write', uri, trustDomain, result: 'deny', requestId, detail: { reason: e.message } });
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const result = await storeTrace(
          adapter,
          { uri, trustDomain, subject: claims.sub, privateKeyPem: config.privateKeyPem },
          input
        );
        audit.record({ actor: claims.sub, action: 'write', uri, trustDomain, result: 'allow', requestId });
        return sendJson(res, 201, result);
      } catch (e) {
        logger.error('ingest_error', { requestId, error: e.message });
        audit.record({ actor: claims.sub, action: 'write', uri, trustDomain, result: 'error', requestId, detail: { error: e.message } });
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (path === '/search' && req.method === 'GET') {
      if (rateLimited(req, res, requestId)) return;
      const q = parsed.query.q;
      const domain = parsed.query.domain || config.trustDomain;
      const k = Math.min(Number(parsed.query.k) || 5, config.searchKMax);
      if (!q) return sendJson(res, 400, { error: 'Missing query parameter q' });
      let claims;
      try {
        claims = await authorize(req, `memory://${domain}/search`, 'read');
      } catch (e) {
        audit.record({ action: 'search', trustDomain: domain, result: 'deny', requestId, detail: { reason: e.message } });
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const embedding = toVectorLiteral(await embed(String(q)));
        const results = await adapter.search({ embedding, k, trustDomain: domain || null });
        audit.record({ actor: claims.sub, action: 'search', trustDomain: domain, result: 'allow', requestId, detail: { q: String(q), k, hits: results.length } });
        return sendJson(res, 200, { query: q, count: results.length, results });
      } catch (e) {
        logger.error('search_error', { requestId, error: e.message });
        return sendJson(res, 500, { error: 'Internal error' });
      }
    }

    // Distill stored reasoning/memory into a fine-tune job (distill capability).
    if (path === '/distill' && req.method === 'POST') {
      if (rateLimited(req, res, requestId)) return;
      let body;
      try {
        body = await readJsonBody(req, config.bodyLimitBytes);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const trustDomain = body.trustDomain || config.trustDomain;
      if (!trustDomain) return sendJson(res, 400, { error: 'trustDomain not set (body.trustDomain or TRUST_DOMAIN)' });
      let claims;
      try {
        claims = await authorize(req, `memory://${trustDomain}/dataset`, 'distill');
      } catch (e) {
        audit.record({ action: 'distill', trustDomain, result: 'deny', requestId, detail: { reason: e.message } });
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const result = await runDistillation(adapter, config, {
          trustDomain,
          kind: body.kind ?? 'trace',
          since: body.since ?? null,
          limit: body.limit,
          format: body.format,
          baseModel: body.baseModel,
          suffix: body.suffix,
          subject: claims.sub,
        });
        audit.record({ actor: claims.sub, action: 'distill', uri: result.datasetUri, trustDomain, result: 'allow', requestId, detail: { examples: result.examples, provider: result.provider, jobId: result.jobId } });
        return sendJson(res, 201, result);
      } catch (e) {
        logger.error('distill_error', { requestId, error: e.message });
        audit.record({ action: 'distill', trustDomain, result: 'error', requestId, detail: { error: e.message } });
        return sendJson(res, 400, { error: e.message });
      }
    }

    // Fine-tune job status via the configured provider (read capability).
    if (path === '/finetune' && req.method === 'GET') {
      if (rateLimited(req, res, requestId)) return;
      const jobId = parsed.query.jobId;
      const domain = parsed.query.domain || config.trustDomain;
      if (!jobId) return sendJson(res, 400, { error: 'Missing query parameter jobId' });
      try {
        await authorize(req, `memory://${domain}/dataset`, 'read');
      } catch (e) {
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const status = await fineTuneStatus(config, String(jobId));
        return sendJson(res, 200, status);
      } catch (e) {
        logger.error('finetune_status_error', { requestId, error: e.message });
        return sendJson(res, 502, { error: e.message });
      }
    }

    return sendText(res, 404, 'Not found');
  } catch (e) {
    logger.error('unhandled_request_error', { requestId, error: e.message, stack: e.stack });
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
  }
});

server.listen(config.port, () => {
  logger.info('carma_listening', { port: config.port, config: redactedSummary(config) });
});

// ---------- lifecycle ----------

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_start', { signal });
  server.close(() => {
    adapter.close().finally(() => {
      logger.info('shutdown_complete', {});
      process.exit(0);
    });
  });
  // Don't hang forever on lingering connections.
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (e) => {
  logger.error('uncaught_exception', { error: e.message, stack: e.stack });
  process.exit(1);
});

export { server };
