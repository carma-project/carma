// Central, validated configuration. Parsing is a pure function of an env-like
// object so it can be unit-tested; the module also exports a default config
// parsed from process.env.

function toInt(value, def) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function toBool(value, def = false) {
  if (value === undefined || value === '') return def;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function parseConfig(env = {}) {
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
    // Distillation / fine-tuning
    finetuneProvider: (env.FINETUNE_PROVIDER || 'local').toLowerCase(),
    fireworksApiKey: env.FIREWORKS_API_KEY || '',
    fireworksAccountId: env.FIREWORKS_ACCOUNT_ID || '',
    fireworksBaseUrl: env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai',
    fireworksBaseModel: env.FIREWORKS_BASE_MODEL || 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    distillOutputDir: env.DISTILL_OUTPUT_DIR || '/tmp/carma-datasets',
    distillMaxExamples: toInt(env.DISTILL_MAX_EXAMPLES, 50000),
    distillSystemPrompt: env.DISTILL_SYSTEM_PROMPT || '',
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
    tokenMaxAgeRead: cfg.tokenMaxAgeRead,
    tokenMaxAgeWrite: cfg.tokenMaxAgeWrite,
    rateLimit: cfg.rateLimitEnabled ? { rps: cfg.rateLimitRps, burst: cfg.rateLimitBurst } : false,
  };
}

export const config = parseConfig(process.env);
