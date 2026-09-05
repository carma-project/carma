import http from 'http';
import url from 'url';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { importSPKI } from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { verifyCapability } from './middleware/jwt.js';
import { enforceCapability, sanitizeUri, enforceTokenLifetime } from './middleware/guardrails.js';
import { embed, toVectorLiteral } from './embedding.js';
import { storeTrace, newTraceUri, recordOutcome, retractMemory } from './ingest.js';
import { toPrecedent, weightsFromConfig, policyFromConfig } from './recall.js';
import { runDistillation, fineTuneStatus } from './distill/pipeline.js';
import { runDream } from './consolidate/dream.js';
import { getMemoryModel } from './memory/model.js';
import { CARMAMCPServer } from './mcp/index.js';
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
const memoryModel = getMemoryModel(config);
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

// ---------- MCP over Streamable HTTP ----------
// Any MCP-compatible agent harness (local or remote) can connect here for
// memory recall/ingest. Sessions are opened by an initialize POST carrying a
// capability token; per-session tool permissions are derived from that token,
// so the same governance model applies as the REST API. CARMA is not tied to
// any single agent framework or model provider — it speaks the open protocol.
const mcpSessions = new Map(); // sessionId -> StreamableHTTPServerTransport

async function authorizeMcp(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) throw new Error('Missing token');
  if (!publicKey) throw new Error('Server missing PUBLIC_KEY');
  if (!config.trustDomain) throw new Error('Server missing TRUST_DOMAIN');
  const claims = await verifyCapability(token, publicKey);
  enforceTokenLifetime(claims, 'read', {
    read: config.tokenMaxAgeRead,
    write: config.tokenMaxAgeWrite,
  });
  // A session requires at least read on this trust domain; store_trace is
  // additionally gated on 'write' inside the MCP server via allowedActions.
  enforceCapability(claims, `memory://${config.trustDomain}/mcp`, 'read');
  const actions = (claims.jsonam && claims.jsonam.actions) || [];
  return { sub: claims.sub, actions };
}

async function handleMcp(req, res, requestId) {
  const sessionId = req.headers['mcp-session-id'];
  const existing = typeof sessionId === 'string' ? mcpSessions.get(sessionId) : undefined;
  if (existing) return existing.handleRequest(req, res);

  // No session yet — only an initialize POST may open one, and it must be
  // authenticated. GET/DELETE without a valid session id are rejected.
  if (req.method !== 'POST') {
    return sendJson(res, 400, { error: 'Missing or unknown mcp-session-id' });
  }

  let grant;
  try {
    grant = await authorizeMcp(req);
  } catch (e) {
    audit.record({ action: 'mcp_connect', result: 'deny', requestId, detail: { reason: e.message } });
    res.setHeader('WWW-Authenticate', 'Bearer');
    return sendJson(res, 401, { error: 'Unauthorized: ' + e.message });
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      mcpSessions.set(sid, transport);
      logger.info('mcp_session_open', { requestId, sessionId: sid, actor: grant.sub });
      audit.record({ actor: grant.sub, action: 'mcp_connect', result: 'allow', requestId, detail: { sessionId: sid, actions: grant.actions } });
    },
  });
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && mcpSessions.delete(sid)) logger.info('mcp_session_close', { sessionId: sid });
  };

  const carma = new CARMAMCPServer(adapter, {
    trustDomain: config.trustDomain,
    privateKeyPem: config.privateKeyPem,
    allowedActions: grant.actions,
    recallWeights: weightsFromConfig(config),
  });
  await carma.server.connect(transport);
  return transport.handleRequest(req, res);
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

  let decision = null;
  if (body.decision != null) {
    if (typeof body.decision !== 'object' || typeof body.decision.choice !== 'string') {
      throw new Error('decision must be an object with a string choice');
    }
    if (body.decision.alternatives != null && !Array.isArray(body.decision.alternatives)) {
      throw new Error('decision.alternatives must be an array');
    }
    decision = { choice: body.decision.choice, ...(body.decision.alternatives ? { alternatives: body.decision.alternatives } : {}) };
  }

  let outcome = null;
  if (body.outcome != null) {
    outcome = validateOutcome(body.outcome);
  }

  const confidence = numInRange(body.confidence, 'confidence', 0, 1);
  const importance = numInRange(body.importance, 'importance', 0, 1);

  let supersedes = null;
  if (body.supersedes != null) supersedes = sanitizeUri(body.supersedes);

  return { task, content, boundContext, decision, outcome, confidence, importance, supersedes };
}

const OUTCOME_STATUSES = ['pending', 'success', 'failure', 'mixed', 'unknown'];

function numInRange(v, name, lo, hi) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  if (v < lo || v > hi) throw new Error(`${name} must be in [${lo}, ${hi}]`);
  return v;
}

function validateOutcome(o) {
  if (typeof o !== 'object') throw new Error('outcome must be an object');
  if (!OUTCOME_STATUSES.includes(o.status)) throw new Error(`outcome.status must be one of ${OUTCOME_STATUSES.join(', ')}`);
  const score = numInRange(o.score, 'outcome.score', -1, 1);
  if (o.evidence != null && typeof o.evidence !== 'string') throw new Error('outcome.evidence must be a string');
  if ((o.evidence || '').length > config.contentMaxLength) throw new Error('outcome.evidence exceeds limit');
  return { status: o.status, ...(score != null ? { score } : {}), ...(o.evidence ? { evidence: o.evidence } : {}) };
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

    // MCP over Streamable HTTP — harness-agnostic memory recall/ingest.
    if (config.mcpHttpEnabled && path === config.mcpHttpPath) {
      return handleMcp(req, res, requestId);
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
        mcp: { httpEnabled: config.mcpHttpEnabled, path: config.mcpHttpPath, stdio: true },
        consolidation: { pendingReviews: null },
      };
      if (config.databaseUrl) {
        try {
          const r = await adapter.check();
          status.database.connected = r.connected;
          status.database.schemaReady = r.schemaReady;
          status.rag.ready = r.ragReady;
          status.audit.ready = r.auditReady;
          try {
            status.consolidation.pendingReviews = await adapter.pendingReviewCount(config.trustDomain || null);
          } catch {
            /* review table may not exist yet */
          }
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
          input,
          policyFromConfig(config)
        );
        audit.record({ actor: claims.sub, action: 'write', uri, trustDomain, result: 'allow', requestId, detail: { ...(input.supersedes ? { supersedes: input.supersedes } : {}), tier: result.tier, reviewQueued: Boolean(result.reviewQueued) } });
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
        const rows = await adapter.search({ embedding, k, trustDomain: domain || null, weights: weightsFromConfig(config) });
        const results = rows.map(toPrecedent);
        audit.record({ actor: claims.sub, action: 'search', trustDomain: domain, result: 'allow', requestId, detail: { q: String(q), k, hits: results.length } });
        return sendJson(res, 200, { query: q, count: results.length, results });
      } catch (e) {
        logger.error('search_error', { requestId, error: e.message });
        return sendJson(res, 500, { error: 'Internal error' });
      }
    }

    // Record how a prior decision turned out (write capability). Feeds recall's
    // outcome weighting so reasoning that worked resurfaces.
    if (path === '/outcome' && req.method === 'POST') {
      if (rateLimited(req, res, requestId)) return;
      let body;
      try {
        body = await readJsonBody(req, config.bodyLimitBytes);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      let decisionUri;
      let outcome;
      try {
        decisionUri = sanitizeUri(body.decisionUri);
        // Flat contract: { decisionUri, status, score?, evidence? } (matches the MCP tool).
        outcome = validateOutcome({ status: body.status, score: body.score, evidence: body.evidence });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const trustDomain = domainOf(decisionUri) || config.trustDomain;
      let claims;
      try {
        claims = await authorize(req, decisionUri, 'write');
      } catch (e) {
        audit.record({ action: 'outcome', uri: decisionUri, trustDomain, result: 'deny', requestId, detail: { reason: e.message } });
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const result = await recordOutcome(
          adapter,
          { trustDomain, subject: claims.sub, privateKeyPem: config.privateKeyPem },
          { decisionUri, status: outcome.status, score: outcome.score, evidence: outcome.evidence }
        );
        audit.record({ actor: claims.sub, action: 'outcome', uri: decisionUri, trustDomain, result: 'allow', requestId, detail: { status: outcome.status, outcomeUri: result.outcomeUri } });
        return sendJson(res, 201, result);
      } catch (e) {
        logger.error('outcome_error', { requestId, error: e.message });
        audit.record({ actor: claims.sub, action: 'outcome', uri: decisionUri, trustDomain, result: 'error', requestId, detail: { error: e.message } });
        return sendJson(res, 400, { error: e.message });
      }
    }

    // Retract a memory: excluded from recall, preserved for audit (write cap).
    if (path === '/retract' && req.method === 'POST') {
      if (rateLimited(req, res, requestId)) return;
      let body;
      try {
        body = await readJsonBody(req, config.bodyLimitBytes);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      let uri;
      try {
        uri = sanitizeUri(body.uri);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const trustDomain = domainOf(uri) || config.trustDomain;
      let claims;
      try {
        claims = await authorize(req, uri, 'write');
      } catch (e) {
        audit.record({ action: 'retract', uri, trustDomain, result: 'deny', requestId, detail: { reason: e.message } });
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const result = await retractMemory(adapter, { trustDomain }, uri);
        audit.record({ actor: claims.sub, action: 'retract', uri, trustDomain, result: 'allow', requestId, detail: { reason: body.reason ?? null } });
        return sendJson(res, 200, result);
      } catch (e) {
        logger.error('retract_error', { requestId, error: e.message });
        return sendJson(res, 400, { error: e.message });
      }
    }

    // Pin/unpin a memory (human curation). Pinned memories get a slight recall
    // boost and never decay. Write capability.
    if (path === '/pin' && req.method === 'POST') {
      if (rateLimited(req, res, requestId)) return;
      let body;
      try {
        body = await readJsonBody(req, config.bodyLimitBytes);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      let uri;
      try {
        uri = sanitizeUri(body.uri);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const trustDomain = domainOf(uri) || config.trustDomain;
      const pinned = body.pinned !== false; // default true
      let claims;
      try {
        claims = await authorize(req, uri, 'write');
      } catch (e) {
        audit.record({ action: 'pin', uri, trustDomain, result: 'deny', requestId, detail: { reason: e.message } });
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const row = await adapter.resolve(uri);
        if (!row) return sendJson(res, 404, { error: 'Not found', id: uri });
        await adapter.setTier(uri, pinned ? 'pinned' : 'consolidated');
        audit.record({ actor: claims.sub, action: 'pin', uri, trustDomain, result: 'allow', requestId, detail: { pinned } });
        return sendJson(res, 200, { uri, tier: pinned ? 'pinned' : 'consolidated' });
      } catch (e) {
        logger.error('pin_error', { requestId, error: e.message });
        return sendJson(res, 400, { error: e.message });
      }
    }

    // List pending consolidation reviews (near-duplicate merge decisions). Read.
    if (path === '/reviews' && req.method === 'GET') {
      if (rateLimited(req, res, requestId)) return;
      const domain = parsed.query.domain || config.trustDomain;
      const statusFilter = parsed.query.status || 'pending';
      try {
        await authorize(req, `memory://${domain}/review`, 'read');
      } catch (e) {
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const reviews = await adapter.listReviews({ trustDomain: domain || null, status: String(statusFilter) });
        return sendJson(res, 200, { count: reviews.length, reviews });
      } catch (e) {
        logger.error('reviews_error', { requestId, error: e.message });
        return sendJson(res, 500, { error: 'Internal error' });
      }
    }

    // Resolve a consolidation review: merge | keep_separate | reject. Write.
    if (path === '/reviews/resolve' && req.method === 'POST') {
      if (rateLimited(req, res, requestId)) return;
      let body;
      try {
        body = await readJsonBody(req, config.bodyLimitBytes);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const resolution = body.resolution;
      if (!['merge', 'keep_separate', 'reject'].includes(resolution)) {
        return sendJson(res, 400, { error: 'resolution must be merge | keep_separate | reject' });
      }
      let review;
      try {
        review = await adapter.getReview(body.reviewId);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      if (!review) return sendJson(res, 404, { error: 'Review not found', id: body.reviewId });
      const trustDomain = review.trust_domain || config.trustDomain;
      let claims;
      try {
        claims = await authorize(req, `memory://${trustDomain}/review`, 'write');
      } catch (e) {
        audit.record({ action: 'review_resolve', trustDomain, result: 'deny', requestId, detail: { reason: e.message } });
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const result = await adapter.resolveReview(body.reviewId, resolution, {
          resolver: claims.sub,
          promoteAt: config.reinforcePromoteAt,
        });
        audit.record({ actor: claims.sub, action: 'review_resolve', uri: review.candidate_uri, trustDomain, result: 'allow', requestId, detail: result });
        return sendJson(res, 200, result);
      } catch (e) {
        logger.error('review_resolve_error', { requestId, error: e.message });
        return sendJson(res, 400, { error: e.message });
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

    // Offline consolidation ("dreaming"): decay stale working memories, recompute
    // tiers from outcomes, batch-detect near-duplicates into the review queue with
    // a model-proposed resolution, and abstract recurring decisions into semantic
    // memories. Mutates memory lifecycle -> gated on 'write'. `dryRun` reports only.
    if (path === '/consolidate' && req.method === 'POST') {
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
        claims = await authorize(req, `memory://${trustDomain}/consolidate`, 'write');
      } catch (e) {
        audit.record({ action: 'consolidate', trustDomain, result: 'deny', requestId, detail: { reason: e.message } });
        return sendText(res, 403, 'Forbidden: ' + e.message);
      }
      try {
        const report = await runDream(adapter, memoryModel, config, {
          trustDomain,
          subject: claims.sub,
          privateKeyPem: config.privateKeyPem,
          dryRun: body.dryRun === true,
          steps: Array.isArray(body.steps) && body.steps.length ? body.steps : undefined,
          limit: body.limit,
        });
        audit.record({
          actor: claims.sub,
          action: 'consolidate',
          trustDomain,
          result: 'allow',
          requestId,
          detail: { dryRun: report.dryRun, decayed: report.decayed.count, promoted: report.promoted.count, reviews: report.reviews.count, abstractions: report.abstractions.count },
        });
        return sendJson(res, 200, report);
      } catch (e) {
        logger.error('consolidate_error', { requestId, error: e.message });
        audit.record({ action: 'consolidate', trustDomain, result: 'error', requestId, detail: { error: e.message } });
        return sendJson(res, 400, { error: e.message });
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
