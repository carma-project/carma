// Central, validated configuration. Parsing is a pure function of an env-like
// object so it can be unit-tested; the module also exports a default config
// parsed from process.env.
import fs from 'node:fs';
import { parseSources, summarizeSource } from './ingest/sources.js';

function toInt(value, def) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function toFloat(value, def) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

function toBool(value, def = false) {
  if (value === undefined || value === '') return def;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function parseList(value, def = []) {
  if (value == null || value === '') return def;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Normalize trust-domain refs to trust://<name>; default to the server domain.
function normDomains(value, trustDomain) {
  const raw = parseList(value, trustDomain ? [String(trustDomain)] : []);
  return raw.map((d) => (d.includes('://') ? d : `trust://${d}`));
}

// SHA-256 fingerprints, compared case-insensitively with ':' stripped.
function parseFingerprints(value) {
  return parseList(value).map((f) => f.replace(/:/g, '').toLowerCase());
}

// Load the raw SOURCES definition from SOURCES_FILE (a path) or SOURCES (inline
// JSON). Returns the raw array plus any parse error, so warnings stay in one place.
function loadSourcesRaw(env) {
  let text = '';
  if (env.SOURCES_FILE) {
    try {
      text = fs.readFileSync(env.SOURCES_FILE, 'utf8');
    } catch (e) {
      return { raw: [], error: `SOURCES_FILE unreadable: ${e.message}` };
    }
  } else if (env.SOURCES) {
    text = env.SOURCES;
  } else {
    return { raw: [], error: null };
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { raw: [], error: 'SOURCES must be a JSON array of source objects.' };
    return { raw: parsed, error: null };
  } catch (e) {
    return { raw: [], error: `SOURCES invalid JSON: ${e.message}` };
  }
}

// Parse a duration to whole seconds. Accepts a bare number (seconds) or a
// suffixed value: 30s, 15m, 2h, 1d. Falls back to `def` on anything invalid.
export function parseDurationSeconds(value, def) {
  if (value == null || value === '') return def;
  const m = String(value).trim().match(/^(\d+)\s*(s|sec|m|min|h|hr|d)?$/i);
  if (!m) return def;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult = unit.startsWith('d') ? 86400 : unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1;
  return n * mult;
}

export function parseConfig(env = {}) {
  const srcLoad = loadSourcesRaw(env);
  const cfg = {
    port: toInt(env.PORT, 7100),
    trustDomain: env.TRUST_DOMAIN || '',
    publicKeyPem: env.PUBLIC_KEY || '',
    privateKeyPem: env.PRIVATE_KEY || '',
    databaseUrl: env.DATABASE_URL || '',
    // 'disable' (default) | 'require' (encrypt, don't verify) | 'verify' (verify CA)
    databaseSsl: (env.DATABASE_SSL || 'disable').toLowerCase(),
    dbPoolMax: toInt(env.DB_POOL_MAX, 10),
    dbIdleTimeoutMs: toInt(env.DB_IDLE_TIMEOUT_MS, 30000),
    dbConnectTimeoutMs: toInt(env.DB_CONNECT_TIMEOUT_MS, 5000),
    embeddingProvider: env.EMBEDDING_PROVIDER || 'local',
    embedDim: toInt(env.EMBED_DIM, 256),
    // Token lifetime ceilings (seconds), enforced per action. Defaults follow
    // docs/SECURITY.md: 15 min for write, 60 min for read.
    tokenMaxAgeRead: toInt(env.TOKEN_MAX_AGE_READ, 3600),
    tokenMaxAgeWrite: toInt(env.TOKEN_MAX_AGE_WRITE, 900),
    rateLimitEnabled: toBool(env.RATE_LIMIT_ENABLED, true),
    rateLimitRps: toInt(env.RATE_LIMIT_RPS, 20),
    rateLimitBurst: toInt(env.RATE_LIMIT_BURST, 40),
    bodyLimitBytes: toInt(env.BODY_LIMIT_BYTES, 1_000_000),
    contentMaxLength: toInt(env.CONTENT_MAX_LENGTH, 100_000),
    boundContextMax: toInt(env.BOUND_CONTEXT_MAX, 256),
    searchKMax: toInt(env.SEARCH_K_MAX, 50),
    // Precedent recall ranking: blend of semantic similarity, outcome signal
    // (prefer reasoning that worked), and recency decay. See adapters/postgres.ts.
    recallWSim: toFloat(env.RECALL_W_SIM, 1.0),
    recallWOutcome: toFloat(env.RECALL_W_OUTCOME, 0.4),
    recallWRecency: toFloat(env.RECALL_W_RECENCY, 0.15),
    recallHalfLifeDays: toFloat(env.RECALL_HALF_LIFE_DAYS, 30),
    // Human-pinned memories get a *slight* boost (not an override).
    recallPinnedBoost: toFloat(env.RECALL_PINNED_BOOST, 0.1),
    // Reinforced (recurring) memories surface a little higher; bounded in [0,1).
    recallWReinforce: toFloat(env.RECALL_W_REINFORCE, 0.05),
    // Consolidation: on write, a near-duplicate above this cosine similarity is
    // queued for human review (merge / keep-separate / reject) — never merged
    // silently.
    consolidateSimThreshold: toFloat(env.CONSOLIDATE_SIM_THRESHOLD, 0.92),
    // A new trace enters as 'consolidated' when confident/important enough,
    // otherwise 'working' (decays unless reinforced/promoted).
    tierConsolidateMinConfidence: toFloat(env.TIER_CONSOLIDATE_MIN_CONFIDENCE, 0.8),
    tierConsolidateMinImportance: toFloat(env.TIER_CONSOLIDATE_MIN_IMPORTANCE, 0.7),
    // Reinforcement count at which a working memory auto-promotes to consolidated.
    reinforcePromoteAt: toInt(env.REINFORCE_PROMOTE_AT, 3),
    // Offline consolidation ("dreaming"): batch maintenance run via `npm run dream`
    // / POST /consolidate. Decays stale working memories, recomputes tiers/salience
    // from outcomes, batch-detects near-duplicates (into the human review queue with
    // a model-proposed resolution), and abstracts recurring decisions into semantic
    // memories that feed distillation.
    dreamDecayDays: toFloat(env.DREAM_DECAY_DAYS, 30),
    // A stale working memory is kept (not archived) if it has been reinforced or
    // recorded a success — only truly unused, unproven memories fade.
    dreamMinReinforceKeep: toInt(env.DREAM_MIN_REINFORCE_KEEP, 1),
    // Near-duplicate similarity that raises a review in the batch dedup pass.
    dreamSimThreshold: toFloat(env.DREAM_SIM_THRESHOLD, 0.92),
    // Minimum number of decisions on the same task before it is abstracted into a
    // reusable semantic memory (principle).
    dreamMinClusterSize: toInt(env.DREAM_MIN_CLUSTER_SIZE, 3),
    // Cap on the number of near-duplicate reviews / semantic memories a single run
    // will create, so a dream pass stays bounded.
    dreamMaxReviews: toInt(env.DREAM_MAX_REVIEWS, 100),
    dreamMaxAbstractions: toInt(env.DREAM_MAX_ABSTRACTIONS, 50),
    // Pluggable memory model for consolidation reasoning (proposals + gisting).
    // 'local' is deterministic and offline (default); 'fireworks' uses an
    // OpenAI-compatible chat endpoint. Provider-neutral: bring any model backend.
    memoryModelProvider: (env.MEMORY_MODEL_PROVIDER || 'local').toLowerCase(),
    memoryModelName: env.MEMORY_MODEL_NAME || 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    // Distillation / fine-tuning
    finetuneProvider: (env.FINETUNE_PROVIDER || 'local').toLowerCase(),
    fireworksApiKey: env.FIREWORKS_API_KEY || '',
    fireworksAccountId: env.FIREWORKS_ACCOUNT_ID || '',
    fireworksBaseUrl: env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai',
    fireworksBaseModel: env.FIREWORKS_BASE_MODEL || 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    distillOutputDir: env.DISTILL_OUTPUT_DIR || '/tmp/carma-datasets',
    distillMaxExamples: toInt(env.DISTILL_MAX_EXAMPLES, 50000),
    distillSystemPrompt: env.DISTILL_SYSTEM_PROMPT || '',
    // MCP over Streamable HTTP: lets any remote MCP-compatible agent harness
    // connect for memory recall/ingest at MCP_HTTP_PATH. stdio is always
    // available for local harnesses via `npm run mcp`.
    mcpHttpEnabled: toBool(env.MCP_HTTP_ENABLED, true),
    mcpHttpPath: env.MCP_HTTP_PATH || '/mcp',
    // Capability issuance endpoint (POST /capability): mTLS-gated minting of
    // short-lived, scoped tokens so clients (e.g. Cyberorbit) request access
    // without ever holding the signing key. Fail-closed: off unless enabled.
    capabilityEndpointEnabled: toBool(env.CAPABILITY_ENDPOINT_ENABLED, false),
    // How the client's verified identity is established:
    //  'direct' — CARMA terminates TLS and verifies the client cert against
    //             CAPABILITY_CLIENT_CA (true mTLS; self-hosted / L4 passthrough).
    //  'proxy'  — a trusted TLS-terminating proxy verifies the client cert and
    //             forwards the identity via headers, trusted only when the
    //             request carries the shared CAPABILITY_PROXY_SECRET.
    mtlsMode: (env.MTLS_MODE || 'direct').toLowerCase(),
    // Direct mode TLS materials: server cert/key and the CA that must have
    // signed acceptable client certs.
    tlsCertPem: env.TLS_CERT || '',
    tlsKeyPem: env.TLS_KEY || '',
    capabilityClientCaPem: env.CAPABILITY_CLIENT_CA || '',
    // Proxy mode: shared secret + header names carrying the verified identity.
    mtlsProxySecret: env.CAPABILITY_PROXY_SECRET || '',
    mtlsProxySecretHeader: (env.CAPABILITY_PROXY_SECRET_HEADER || 'x-proxy-authorization').toLowerCase(),
    mtlsProxySubjectHeader: (env.CAPABILITY_PROXY_SUBJECT_HEADER || 'x-client-subject').toLowerCase(),
    mtlsProxyVerifyHeader: (env.CAPABILITY_PROXY_VERIFY_HEADER || 'x-client-verify').toLowerCase(),
    mtlsProxyFingerprintHeader: (env.CAPABILITY_PROXY_FINGERPRINT_HEADER || 'x-client-fingerprint').toLowerCase(),
    // Policy ceilings for issued tokens. Domains default to the server trust
    // domain; a bare name is normalized to trust://<name>.
    capabilityDomains: normDomains(env.CAPABILITY_DOMAINS, env.TRUST_DOMAIN),
    capabilityMaxActions: parseList(env.CAPABILITY_MAX_ACTIONS, ['read', 'write']),
    capabilityMaxTtlSeconds: parseDurationSeconds(env.CAPABILITY_MAX_TTL, 900),
    // Optional allow-list of trusted client-cert SHA-256 fingerprints. When set,
    // a client identity must present a matching fingerprint (fail-closed).
    capabilityTrustedFingerprints: parseFingerprints(env.CAPABILITY_TRUSTED_FINGERPRINTS),
    // Native ingestion: the external systems CARMA pulls context from (git repos
    // today). Runs in-process like consolidation — no external cron/CI required.
    // Triggered on demand (POST /ingest) or by the internal scheduler. Each
    // source may set intervalMinutes to be picked up by the scheduler.
    sources: parseSources(srcLoad.raw),
    // Where working checkouts live (cloned once, fast-forwarded thereafter).
    ingestWorkDir: env.INGEST_WORK_DIR || '/tmp/carma-sources',
    // Internal scheduler: when enabled, sources with intervalMinutes>0 are pulled
    // on their cadence. Off by default (POST /ingest still works).
    ingestSchedulerEnabled: toBool(env.INGEST_SCHEDULER_ENABLED, false),
    // Pull all sources once shortly after boot (backfill on first deploy).
    ingestOnBoot: toBool(env.INGEST_ON_BOOT, false),
    // How often the scheduler wakes to check which sources are due.
    ingestSchedulerTickMs: toInt(env.INGEST_SCHEDULER_TICK_MS, 60000),
    logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
    hstsEnabled: toBool(env.HSTS_ENABLED, false),
    // If true, boot fails fast when required config is missing/invalid.
    strictBoot: toBool(env.STRICT_BOOT, false),
  };

  cfg.warnings = [];
  if (!cfg.publicKeyPem) cfg.warnings.push('PUBLIC_KEY not set — authenticated endpoints will 403.');
  if (!cfg.privateKeyPem) cfg.warnings.push('PRIVATE_KEY not set — trace ingest/signing will fail.');
  if (!cfg.databaseUrl) cfg.warnings.push('DATABASE_URL not set — resolve/ingest/search unavailable.');
  if (!cfg.trustDomain) cfg.warnings.push('TRUST_DOMAIN not set — ingest/search require an explicit domain.');
  if (!['disable', 'require', 'verify'].includes(cfg.databaseSsl)) {
    cfg.warnings.push(`DATABASE_SSL="${cfg.databaseSsl}" invalid; falling back to "disable".`);
    cfg.databaseSsl = 'disable';
  }
  if (cfg.embeddingProvider !== 'local') {
    cfg.warnings.push(`EMBEDDING_PROVIDER="${cfg.embeddingProvider}" — only "local" is implemented.`);
  }
  if (cfg.finetuneProvider === 'fireworks' && (!cfg.fireworksApiKey || !cfg.fireworksAccountId)) {
    cfg.warnings.push('FINETUNE_PROVIDER=fireworks but FIREWORKS_API_KEY/FIREWORKS_ACCOUNT_ID are not both set.');
  } else if (!['local', 'fireworks'].includes(cfg.finetuneProvider)) {
    cfg.warnings.push(`FINETUNE_PROVIDER="${cfg.finetuneProvider}" unknown; supported: local, fireworks.`);
  }
  if (!['local', 'fireworks'].includes(cfg.memoryModelProvider)) {
    cfg.warnings.push(`MEMORY_MODEL_PROVIDER="${cfg.memoryModelProvider}" unknown; supported: local, fireworks. Falling back to local.`);
    cfg.memoryModelProvider = 'local';
  }
  if (cfg.memoryModelProvider === 'fireworks' && !cfg.fireworksApiKey) {
    cfg.warnings.push('MEMORY_MODEL_PROVIDER=fireworks but FIREWORKS_API_KEY is not set — dream will fall back to local reasoning.');
  }
  if (cfg.capabilityEndpointEnabled) {
    if (!['direct', 'proxy'].includes(cfg.mtlsMode)) {
      cfg.warnings.push(`MTLS_MODE="${cfg.mtlsMode}" invalid; supported: direct, proxy. Falling back to direct.`);
      cfg.mtlsMode = 'direct';
    }
    if (!cfg.privateKeyPem) cfg.warnings.push('CAPABILITY_ENDPOINT_ENABLED but PRIVATE_KEY is not set — POST /capability cannot mint tokens.');
    if (cfg.mtlsMode === 'direct' && (!cfg.tlsCertPem || !cfg.tlsKeyPem)) {
      cfg.warnings.push('MTLS_MODE=direct but TLS_CERT/TLS_KEY are not both set — CARMA cannot terminate TLS to verify client certs; POST /capability will 401.');
    }
    if (cfg.mtlsMode === 'direct' && !cfg.capabilityClientCaPem) {
      cfg.warnings.push('MTLS_MODE=direct but CAPABILITY_CLIENT_CA is not set — no client certificates can be verified; POST /capability will 401.');
    }
    if (cfg.mtlsMode === 'proxy' && !cfg.mtlsProxySecret) {
      cfg.warnings.push('MTLS_MODE=proxy but CAPABILITY_PROXY_SECRET is not set — forwarded client identity cannot be trusted; POST /capability will 401.');
    }
    if (!cfg.capabilityDomains.length) cfg.warnings.push('CAPABILITY_ENDPOINT_ENABLED but no CAPABILITY_DOMAINS/TRUST_DOMAIN — nothing can be issued.');
    if (!cfg.capabilityMaxActions.length) cfg.warnings.push('CAPABILITY_MAX_ACTIONS is empty — POST /capability will issue no actions.');
  }

  if (srcLoad.error) {
    cfg.warnings.push(srcLoad.error);
  } else if (srcLoad.raw.length && cfg.sources.length < srcLoad.raw.length) {
    cfg.warnings.push('Some SOURCES entries were dropped (each needs a unique id and a url/path).');
  }
  for (const s of cfg.sources) {
    if (s.type !== 'git') cfg.warnings.push(`SOURCES: source "${s.id}" type "${s.type}" is unsupported (only "git").`);
  }
  if (cfg.sources.length && !cfg.privateKeyPem) {
    cfg.warnings.push('SOURCES configured but PRIVATE_KEY is not set — ingestion cannot sign memory.');
  }
  if (cfg.ingestSchedulerEnabled && !cfg.sources.some((s) => s.intervalMinutes > 0)) {
    cfg.warnings.push('INGEST_SCHEDULER_ENABLED but no source sets intervalMinutes>0 — the scheduler will do nothing.');
  }

  // When true, the HTTP listener is upgraded to HTTPS so CARMA can terminate
  // TLS and verify client certs itself (direct mTLS for POST /capability).
  cfg.mtlsDirectTls =
    cfg.capabilityEndpointEnabled && cfg.mtlsMode === 'direct' && Boolean(cfg.tlsCertPem) && Boolean(cfg.tlsKeyPem);

  // Node pg SSL config, or false to disable.
  cfg.dbSslConfig =
    cfg.databaseSsl === 'disable'
      ? false
      : { rejectUnauthorized: cfg.databaseSsl === 'verify' };

  return cfg;
}

// A copy safe to log: no secret material, only presence booleans.
export function redactedSummary(cfg) {
  return {
    port: cfg.port,
    trustDomain: cfg.trustDomain || null,
    publicKey: Boolean(cfg.publicKeyPem),
    privateKey: Boolean(cfg.privateKeyPem),
    database: Boolean(cfg.databaseUrl),
    databaseSsl: cfg.databaseSsl,
    embeddingProvider: cfg.embeddingProvider,
    embedDim: cfg.embedDim,
    finetuneProvider: cfg.finetuneProvider,
    mcpHttp: cfg.mcpHttpEnabled ? cfg.mcpHttpPath : false,
    capability: cfg.capabilityEndpointEnabled
      ? { mode: cfg.mtlsMode, tls: cfg.mtlsDirectTls ? 'direct' : 'proxy-or-none', domains: cfg.capabilityDomains, maxActions: cfg.capabilityMaxActions, maxTtlSeconds: cfg.capabilityMaxTtlSeconds, fingerprintPinned: cfg.capabilityTrustedFingerprints.length > 0 }
      : false,
    recall: { sim: cfg.recallWSim, outcome: cfg.recallWOutcome, recency: cfg.recallWRecency, halfLifeDays: cfg.recallHalfLifeDays, pinnedBoost: cfg.recallPinnedBoost, reinforce: cfg.recallWReinforce },
    consolidate: { simThreshold: cfg.consolidateSimThreshold, promoteAt: cfg.reinforcePromoteAt },
    dream: { decayDays: cfg.dreamDecayDays, simThreshold: cfg.dreamSimThreshold, minCluster: cfg.dreamMinClusterSize, model: cfg.memoryModelProvider },
    sources: cfg.sources.map(summarizeSource),
    ingest: { scheduler: cfg.ingestSchedulerEnabled, onBoot: cfg.ingestOnBoot, workDir: cfg.ingestWorkDir, tickMs: cfg.ingestSchedulerTickMs },
    tokenMaxAgeRead: cfg.tokenMaxAgeRead,
    tokenMaxAgeWrite: cfg.tokenMaxAgeWrite,
    rateLimit: cfg.rateLimitEnabled ? { rps: cfg.rateLimitRps, burst: cfg.rateLimitBurst } : false,
  };
}

export const config = parseConfig(process.env);
