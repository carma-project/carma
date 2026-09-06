# AGENTS.md

Guidance for coding agents working on CARMA (JSON-AM reference implementation).

## Running the app

- Install deps: `npm install`
- Dev server: `npm run dev` (runs `tsx server/index.js`), listens on port `7100`.
- Production start: `npm start` (runs `node --import tsx server/index.js`).
- MCP server (stdio): `npm run mcp` (runs `node --import tsx server/mcp/stdio.ts`).
- Migrations: `npm run migrate` (applies `adapters/migrations/*.sql`, needs pgvector).
- Mint a capability token: `npm run mint-token -- --domains trust://acme --actions read,write`.
- Distill -> fine-tune: `npm run distill -- --domain acme --kind trace --base-model <model>`
  (provider via `FINETUNE_PROVIDER`; `local` default, `fireworks` for hosted SFT).
- Consolidate ("dream"): `npm run dream -- --domain acme [--dry-run] [--steps decay,promote,dedup,abstract]`
  (offline batch memory maintenance; memory model via `MEMORY_MODEL_PROVIDER`, `local` default).
- End-to-end smoke test: `npm run smoke` (reads `PORT`/`TRUST_DOMAIN`/`PRIVATE_KEY`, mints a token
  in-process, exercises status/ingest/outcome/search/consolidate over `fetch`; no `curl`/`jq` needed,
  so it runs inside the `node:20-alpine` container). Override with `--url`/`--domain`/`--k`.
- **Native ingestion (recommended): CARMA pulls sources itself, in-process** — no external
  cron/CI. Declare `SOURCES` (JSON) — git repos, Postgres/SQL, HTTP JSON APIs, and GitHub
  issues/PRs (see Configuration) — and either trigger `POST /ingest` (write; body
  `{ sourceId?, dryRun? }`) or enable the scheduler (`INGEST_ON_BOOT` / `INGEST_SCHEDULER_ENABLED`
  + per-source `intervalMinutes`). CARMA collects each source and stores memory via `storeTrace`
  directly (signed with the server `PRIVATE_KEY`; no token minted). This is the acquisition
  counterpart to `dream`, closing the loop **pull → consolidate → post-train** inside the
  container. Git ingestion shares extractors with the CLIs below. See `docs/INGEST_REPO.md` §0.
- Ingest a repo's markdown (agent specs, decisions/ADRs, "company OS" docs) into memory *from
  outside* (push via `POST /memory`; for air-gapped sources or ad-hoc backfills):
  `npm run ingest-repo -- --dir <path> --url <carma-url> --domain <domain> [--repo owner/name]
  [--dry-run] [--no-split] [--exclude a,b]`. Classifies by path/front-matter, splits on `#`/`##`,
  and upserts each section under a deterministic `trace://<domain>/gh/<repo>/<path>#<slug>` URI
  (idempotent — safe to re-run per push). Auth via `--token`/`CARMA_TOKEN`, else mints from
  `PRIVATE_KEY`. Full guide + GitHub Actions sync template: `docs/INGEST_REPO.md`.
- Ingest a repo's **git history** (the reasoning behind every change): `npm run ingest-git -- --dir
  <path> --url <carma-url> --domain <domain> [--repo owner/name] [--since "30 days ago"] [--branch b]
  [--max N] [--dry-run]`. Each commit becomes a dated `trace://<domain>/gh/<repo>/commit/<sha>`
  decision (author date preserved via `occurredAt`), and reverts record a `failure` outcome on the
  commit they undo. Commits enter the `working` tier (episodic; decay unless recalled), vs. curated
  docs/ADRs which are `consolidated`.
- Private CARMA (no public internet): prefer **native ingestion** above — if CARMA can reach the
  repo it needs no external runner. Otherwise the importers dial out to CARMA, so run the sync
  inside the network: `scripts/sync-repo.sh` runs both importers for one checkout (env: `CARMA_URL`,
  `TRUST_DOMAIN`, `REPO_DIR`, `REPO_SLUG`, `PRIVATE_KEY`/`CARMA_TOKEN`). For Railway, deploy
  `docs/examples/Dockerfile.sync` as a cron service in the same project (reaches
  `carma.railway.internal`). The CARMA runtime image now includes `git` (needed for the native and
  history importers). See `docs/INGEST_REPO.md` §2c.
- Tests: `npm test` (unit always; integration + MCP tests run only when `DATABASE_URL` is set).

The entrypoint `server/index.js` imports its middleware/adapters with `.js` specifiers, but
those files are TypeScript (`server/**/*.ts`, `adapters/*.ts`). Plain `node server/index.js`
fails with `ERR_MODULE_NOT_FOUND`; `tsx` resolves the `.js` specifiers to their `.ts` sources.
`tsx` is a runtime dependency (not dev-only) so it is present in production images.

## Configuration

Config is centralized and validated in `server/config.js` (`parseConfig(env)` is pure and
unit-tested; a redacted summary is logged at boot).

Core:
- `PORT` — HTTP port (default `7100`).
- `PUBLIC_KEY` — Ed25519 **SPKI PEM**. Imported at startup via `jose.importSPKI(..., 'EdDSA')`
  to verify capability tokens. If unset/invalid, the process still boots and `/health` works,
  but authenticated endpoints return `403`.
- `PRIVATE_KEY` — Ed25519 **PKCS8 PEM**. Signs stored envelopes on ingest and mints tokens.
- `DATABASE_URL` — Postgres connection string (needs pgvector). Run `npm run migrate` first.
- `TRUST_DOMAIN` — default trust domain for ingest/search when not supplied per-request.
- `EMBEDDING_PROVIDER` (default `local`, deterministic, no network) / `EMBED_DIM` (default `256`,
  must match the `vector(N)` column).
- `FINETUNE_PROVIDER` (`local` default | `fireworks`) + `FIREWORKS_API_KEY` / `FIREWORKS_ACCOUNT_ID` /
  `FIREWORKS_BASE_MODEL` / `FIREWORKS_BASE_URL`; `DISTILL_OUTPUT_DIR` / `DISTILL_MAX_EXAMPLES` /
  `DISTILL_SYSTEM_PROMPT` for the distillation pipeline.

Production/hardening:
- `DATABASE_SSL` — `disable` (default) | `require` (encrypt, don't verify) | `verify` (verify CA).
  Managed Postgres (Railway/RDS) typically needs `require`.
- `DB_POOL_MAX` / `DB_IDLE_TIMEOUT_MS` / `DB_CONNECT_TIMEOUT_MS` — pool sizing/timeouts.
- `TOKEN_MAX_AGE_READ` (default `3600`) / `TOKEN_MAX_AGE_WRITE` (default `900`) — per-action token
  age ceilings in seconds (docs/SECURITY.md), enforced on top of `exp`.
- `RATE_LIMIT_ENABLED` (default `true`) / `RATE_LIMIT_RPS` (`20`) / `RATE_LIMIT_BURST` (`40`) —
  per-client token-bucket limiter; returns `429` with `Retry-After`.
- `BODY_LIMIT_BYTES` (`1000000`) / `CONTENT_MAX_LENGTH` (`100000`) / `BOUND_CONTEXT_MAX` (`256`) /
  `SEARCH_K_MAX` (`50`) — input limits.
- `RECALL_W_SIM` (`1.0`) / `RECALL_W_OUTCOME` (`0.4`) / `RECALL_W_RECENCY` (`0.15`) /
  `RECALL_HALF_LIFE_DAYS` (`30`) — precedent-recall ranking blend (similarity × outcome × recency).
- `RECALL_PINNED_BOOST` (`0.1`) / `RECALL_W_REINFORCE` (`0.05`) — recall boosts for pinned memories
  and for memories that have been reinforced (recalled/merged) repeatedly.
- `CONSOLIDATE_SIM_THRESHOLD` (`0.92`) — on write, a candidate within this cosine similarity of an
  existing memory enqueues a human consolidation review instead of silently merging.
- `TIER_CONSOLIDATE_MIN_CONFIDENCE` (`0.8`) / `TIER_CONSOLIDATE_MIN_IMPORTANCE` (`0.7`) — thresholds
  above which a new memory is admitted directly to the `consolidated` tier (else `working`).
- `REINFORCE_PROMOTE_AT` (`3`) — reinforcement count at which a `working` memory auto-promotes to
  `consolidated`.
- `DREAM_DECAY_DAYS` (`30`) / `DREAM_MIN_REINFORCE_KEEP` (`1`) — offline consolidation: a `working`
  memory older than the decay window with fewer reinforcements and no recorded success is archived.
- `DREAM_SIM_THRESHOLD` (`0.92`) / `DREAM_MIN_CLUSTER_SIZE` (`3`) — batch near-duplicate similarity
  for the dedup pass, and minimum decisions on one task before it is abstracted into a semantic memory.
- `DREAM_MAX_REVIEWS` (`100`) / `DREAM_MAX_ABSTRACTIONS` (`50`) — per-run caps so a dream pass is bounded.
- `MEMORY_MODEL_PROVIDER` (`local` default | `fireworks` | `openai`) / `MEMORY_MODEL_NAME` — the
  pluggable model used for consolidation reasoning (near-duplicate proposals + episodic→semantic
  gisting). `local` is deterministic and offline; `fireworks` uses the Fireworks chat API; `openai`
  targets any OpenAI-compatible `/v1/chat/completions` endpoint — a self-hosted **vLLM** or **Ollama**
  — via `MEMORY_MODEL_BASE_URL` (or the shared `INFERENCE_BASE_URL`, e.g. `http://vllm:8000/v1`) and an
  optional `MEMORY_MODEL_API_KEY`/`OPENAI_API_KEY` (keyless self-hosted servers work). Any provider
  falls back to
  local on any error. Provider-neutral — bring any backend.
Native ingestion (sources CARMA pulls itself):
- `SOURCES` (inline JSON array) or `SOURCES_FILE` (path to that JSON) — source definitions, one per
  connector. Pluggable connectors live in `server/ingest/connectors/` (registry in `index.ts`); the
  common write path is `server/ingest/run.ts`. `intervalMinutes>0` makes a source eligible for the
  scheduler. Supported `type`s:
  - `git` — `{ id, type:"git", url|path, repo?, branch?, since?, docs?, history?, maxCommits?, exclude?, tokenEnv? }`.
    Ingests markdown (specs/decisions/OS docs) + full commit history (reverts → failure outcome).
  - `postgres` — `{ id, type:"postgres", dsnEnv|dsn, query, ssl?, columns:{id,title,content,date?,decision?}, confidence?, importance? }`.
    Runs a read-only SQL query; each row → a memory. Use a read-only role; prefer `dsnEnv`.
  - `http` — `{ id, type:"http", url, headers?, tokenEnv?, itemsPath?, fields:{id,title,content,date?,decision?}, confidence?, importance? }`.
    GETs a JSON list (at `itemsPath`) and maps each record.
  - `github` — `{ id, type:"github", repo:"owner/name", tokenEnv?, apiBase?, state?, since?, maxPages?, includeComments?, maxComments? }`.
    Ingests issues + PRs (with comment threads); merged PR → success, "not planned" → failure.
  Secrets (`dsn`, `url`, `query`, tokens) never appear in `/api/status` or logs. See `docs/INGEST_REPO.md`;
  a full Cyberorbit wiring is in `docs/CYBERORBIT.md` + `docs/examples/cyberorbit-sources.json`.
- `INGEST_WORK_DIR` (`/tmp/carma-sources`) — where checkouts are cloned/cached (fast-forwarded on re-run).
- `INGEST_ON_BOOT` (`false`) — pull all sources once shortly after startup (first-deploy backfill).
- `INGEST_SCHEDULER_ENABLED` (`false`) / `INGEST_SCHEDULER_TICK_MS` (`60000`) — run due sources on
  their `intervalMinutes` cadence. Runs are serialized (a manual `POST /ingest` and the scheduler
  never overlap). `GET /api/status` reports each source and its last run under `ingest.sources[]`.
- `LOG_LEVEL` (`info`) — structured JSON logs; each request gets an `X-Request-Id`.
- `HSTS_ENABLED` (`false`) — send HSTS (enable when TLS terminates at/after the proxy).
- `STRICT_BOOT` (`false`) — fail fast at startup if `PUBLIC_KEY`/`PRIVATE_KEY`/`DATABASE_URL`
  are missing (recommended in production).
- `MCP_HTTP_ENABLED` (default `true`) / `MCP_HTTP_PATH` (default `/mcp`) — expose the MCP
  Streamable HTTP transport on the main server so remote agent harnesses can connect.
- `STATUS_PUBLIC` (default `false`) — when false, unauthenticated `GET /api/status` returns only
  coarse readiness booleans; the full detail (trust domain, configured sources incl. repo slugs,
  ingest state) requires a read capability. Set `true` to expose the full detail anonymously (local/dev).
- `UI_ENABLED` (default `true`) — serve the built-in config UI at `/` and `/ui`; disable in hardened
  deployments. See `docs/EXPOSURE.md` for the no-public-listener (Zero-Trust tunnel) topology.
- `WAKE_RECENT` (`5`) / `WAKE_IDENTITY` (`8`) / `WAKE_RELEVANT` (`5`) — layer sizes for the
  session-start "wake" brief (`POST /wake`, MCP `wake` tool, `memory://<domain>/wake` resource):
  how many recent decisions, identity/self memories, and (when a task is given) relevant precedents.
- `MCP_WAKE_INSTRUCTIONS` (`true`) — carry the agent's identity+recent wake brief as the MCP
  `initialize` response's `instructions`, so a harness reloads the agent's self on connect
  (surviving a context-window compaction). Set `false` to opt out (the `wake` tool/resource still work).
- `CAPABILITY_ENDPOINT_ENABLED` (`false`) — enable `POST /capability` (mTLS-gated token
  issuance/refresh). When enabled:
  - `MTLS_MODE` (`direct`) — `direct`: CARMA terminates TLS and verifies the client cert against
    `CAPABILITY_CLIENT_CA` (needs `TLS_CERT`/`TLS_KEY`; upgrades the listener to HTTPS).
    `proxy`: trust a TLS-terminating proxy's forwarded identity when the request carries
    `CAPABILITY_PROXY_SECRET` (headers `CAPABILITY_PROXY_SECRET_HEADER`/`_SUBJECT_HEADER`/
    `_VERIFY_HEADER`/`_FINGERPRINT_HEADER`).
  - `CAPABILITY_DOMAINS` (default `TRUST_DOMAIN`), `CAPABILITY_MAX_ACTIONS` (default `read,write`),
    `CAPABILITY_MAX_TTL` (default `15m`) — ceilings for issued grants.
  - `CAPABILITY_TRUSTED_FINGERPRINTS` — optional allow-list of client-cert SHA-256 fingerprints.

## Endpoints

- `GET /` (and `/ui`) — built-in, self-contained configuration/readiness UI (no external assets).
  Disabled when `UI_ENABLED=false` (then `404`).
- `GET /api/status` — JSON deploy diagnostics: `PUBLIC_KEY`/`PRIVATE_KEY`, DB connectivity,
  `agent_memory` schema, RAG (pgvector), and audit-log readiness. Booleans only — never secrets.
  Without `STATUS_PUBLIC=true`, anonymous callers get only coarse readiness (`ready` + component
  booleans); full detail (trust domain, sources, ingest state) requires a read capability.
- `GET /health` — liveness (always `200` while the process is up).
- `GET /ready` — readiness (`200` only when it can serve: key valid + DB connected + schema);
  `503` otherwise. Use this for orchestrator readiness probes.
- `POST /capability` — mTLS-gated capability issuance/refresh (off unless
  `CAPABILITY_ENDPOINT_ENABLED`). No bearer token; the caller is authenticated by a client cert
  (direct TLS) or a trusted proxy's forwarded identity. Body: `{ domains?, actions?, ttl? }`
  (all optional; each is intersected with policy). Optional `Authorization: Bearer <token>`
  narrows the new grant on refresh (never widens). Returns `{ token, subject, domains, actions,
  expiresIn }`. `404` when disabled, `401` without a verified client identity. Lets clients
  (e.g. Cyberorbit) request scoped, short-lived tokens without holding the signing key.
- `GET /resolve?uri=...` — resolve an envelope by URI (read capability).
- `POST /memory` — ingest a decision/reasoning trace as a signed `trace://` envelope + recall
  index entry (write capability). Body: `{ task?, content, boundContext?, decision?, outcome?,
  confidence?, importance?, supersedes?, trustDomain?, uri? }`. `supersedes` marks the prior
  version superseded (revision).
- `POST /outcome` — record how a decision turned out (write). Body: `{ decisionUri, status,
  score?, evidence? }`. Writes a signed `Outcome` envelope + updates recall weighting.
- `POST /retract` — exclude a memory from recall, preserved for audit (write). Body: `{ uri, reason? }`.
- `GET /search?q=...&k=5&domain=acme` — precedent recall (read): returns precedents (reasoning,
  decision, outcome, lineage) ranked by similarity × outcome × recency; excludes superseded/retracted.
- `POST /wake` (or `GET /wake?domain=&task=`) — session-start "wake" brief (read): composes the
  agent's durable identity (pinned + semantic principles + agent-specs), most recent decisions, and —
  when `task` is given — the top precedents for it. Body: `{ trustDomain?, task?, recent?, identity?,
  relevant? }`. Returns `{ trustDomain, identity[], recent[], relevant[], openReviews, counts, digest }`
  where `digest` is a ready-to-inject natural-language brief. Read this at the start of a session (or
  after a context compaction) instead of relying on a summarized context window.
- `POST /pin` — pin/unpin a memory (write). Body: `{ uri, pinned? }` (default `true`). Pinned
  memories are boosted in recall and exempt from decay/eviction (see Consolidation & tiers).
- `GET /reviews?domain=acme&status=pending` — list consolidation reviews (near-duplicate merge
  decisions) awaiting a human call (read).
- `POST /reviews/resolve` — resolve a review (write). Body: `{ reviewId, resolution }` where
  `resolution` is `merge` (reinforce the kept memory), `keep_separate` (both stay), or `reject`
  (retract the candidate).
- `POST /consolidate` — run offline consolidation ("dreaming") for a domain (write). Body:
  `{ trustDomain?, steps?, dryRun?, limit? }` where `steps` ⊆ `["decay","promote","dedup","abstract"]`.
  Returns a report: memories archived (decay), promoted (tier recompute), near-duplicate reviews
  raised (each with a model-proposed resolution), and semantic memories abstracted. `dryRun:true`
  reports intended changes without mutating.
- `POST /ingest` — native ingestion: pull a configured source into memory in-process (write). Body:
  `{ sourceId?, dryRun?, trustDomain? }` (omit `sourceId` to run all). Clones/updates the git source
  and stores its markdown + history via `storeTrace`; `dryRun:true` reports counts without writing.
  Returns `{ dryRun, reports:[{ sourceId, repo, docs, commits, outcomes }] }`. `409` if a run is
  already in progress; `404` for an unknown `sourceId`.
- `POST /distill` — distill stored reasoning/memory into a fine-tune job (capability action
  `distill`). Body: `{ trustDomain?, kind?, since?, limit?, format?, baseModel?, suffix? }`.
  Returns `{ datasetUri, examples, provider, baseModel, jobId, status, model }`.
- `GET /finetune?jobId=...` — fine-tune job status via the configured provider (read capability).
- `POST/GET/DELETE /mcp` — MCP Streamable HTTP transport for remote agent harnesses (see MCP
  section). `initialize` requires a bearer capability token; per-session actions come from it.

## MCP (harness-agnostic)

`server/mcp/` exposes CARMA to any MCP-compatible agent harness over two transports —
CARMA is not tied to a specific framework or model provider, it speaks the open protocol.
Tools: `store_trace({ task, content, boundContext, decision?, outcome?, confidence?, importance?,
supersedes? })`, `record_outcome({ decisionUri, status, score?, evidence? })`,
`retract_memory({ uri, reason? })`, `search_memory({ query, k })` (precedent recall), and
`wake({ task?, recent?, identity?, relevant? })` (session-start priming); plus resource reads
(`memory://<domain>/*`, and the composed `memory://<domain>/wake` brief). Envelope schema:
JSON-AM v0.1.3-draft (`docs/JSON-AM.md`).

On connect, an authenticated session's `initialize` response carries the wake brief as the server
`instructions` (unless `MCP_WAKE_INSTRUCTIONS=false`), so a harness that surfaces instructions
reloads the agent's identity/self automatically — the fix for losing personality to a compaction.

- **stdio** (`npm run mcp`) — for local harnesses (Claude Desktop, Cursor, LangGraph, custom
  SDK clients). A stdio connection is a trusted local channel: it operates under `TRUST_DOMAIN`,
  signs with `PRIVATE_KEY`, and has all actions.
- **Streamable HTTP** (`POST/GET/DELETE {MCP_HTTP_PATH}`, default `/mcp`, on the main server) —
  for remote/networked harnesses. A session is opened by an authenticated `initialize` (bearer
  capability token in `Authorization`). Per-session tool permissions are derived from the token's
  `jsonam.actions`: `search_memory`/resource reads need `read`, `store_trace` needs `write`.
  Denials return an MCP `isError` result rather than crashing the client. Connect with the MCP
  SDK's `StreamableHTTPClientTransport` (or any client that speaks MCP Streamable HTTP).

## Testing

Verify with terminal requests. With the server on `:7100`:

- `curl http://localhost:7100/health` -> `ok` (HTTP 200)
- `curl http://localhost:7100/api/status` -> JSON; `"ready":true` once fully configured
- No token -> `403 Forbidden: Missing token`; invalid JWT / wrong domain / missing action -> `403`
- Disallowed scheme / path traversal in `uri` -> `403` (`server/middleware/guardrails.ts`)
- `POST /memory` with a `write` token -> `201 {uri, stored:true}`; then `GET /search?q=...`
  returns that pointer ranked by similarity; `GET /resolve?uri=...` returns the signed envelope.

`npm test` covers this: unit (embedding, JWS, capability, guardrails), integration (ingest ->
pgvector search), and MCP (stdio `store_trace`/`search_memory`). Integration + MCP tests are
skipped unless `DATABASE_URL` points at a pgvector-enabled Postgres.

The full stack (app + pgvector Postgres, migrations auto-applied) runs locally via
`docker compose up --build` after supplying `PUBLIC_KEY` and `PRIVATE_KEY`.

## Deployment

- Container: `Dockerfile` (`node:20-alpine`, `npm ci --omit=dev`, `CMD node --import tsx server/index.js`).
  A `.dockerignore` keeps `node_modules` and local secrets out of the image.
- `docker-compose.yml` uses `pgvector/pgvector:pg16` and mounts `adapters/migrations` into
  the DB init dir, so a fresh volume is migrated automatically.
- Railway builds the `Dockerfile` (`railway.toml` sets `builder = "DOCKERFILE"`); the image `CMD`
  runs `node adapters/migrate.mjs && node --import tsx server/index.js`, so migrations apply on boot
  (idempotent + advisory-locked); healthcheck `/health`. (`nixpacks.toml` keeps an equivalent
  Nixpacks start command for non-Docker builders.) Provide `DATABASE_URL`, `PUBLIC_KEY`,
  `PRIVATE_KEY`, `TRUST_DOMAIN`, and `DATABASE_SSL=require` for managed Postgres over TLS. The
  Postgres service **must** have pgvector (migration `0002` runs `CREATE EXTENSION vector`).
  Both `migrate.mjs` and the server honor `DATABASE_SSL` (`disable`|`require`|`verify`).
  Step-by-step: `docs/DEPLOY_RAILWAY.md`.

## Production hardening

- **AuthZ depth**: capability verify (`jwt.ts`) + per-action token-age ceiling
  (`enforceTokenLifetime`) + domain/action enforcement (`enforceCapability`).
- **Audit**: every access decision (allow/deny/error) is written to the append-only
  `audit_log` table (`server/audit.js`, best-effort — never breaks the request path).
- **Rate limiting**: per-client token bucket (`server/ratelimit.js`) on authenticated routes.
- **Input hardening**: JSON body size cap, trace content/boundContext limits, `k` cap; consistent
  JSON error envelopes.
- **Observability**: structured JSON logs with per-request `X-Request-Id`; security headers
  (`nosniff`, `no-referrer`, optional HSTS).
- **Lifecycle**: graceful `SIGTERM`/`SIGINT` shutdown (drain server, close pool); `uncaughtException`
  exits for orchestrator restart; pool `error` handler prevents idle-client crashes.
- **Migrations**: `npm run migrate` takes a pg advisory lock so concurrent replicas don't race.

## Consolidation & tiers (human-like memory management)

Modeled on how human memory keeps salient material and lets the rest fade. Columns live in
`agent_memory` (migration `0005`); the review queue is table `memory_review`.

- **Tiers** (`tier` column): `working` (default, decay-eligible), `consolidated` (durable, admitted
  by confidence/importance thresholds or promoted by reinforcement), `pinned` (human-protected,
  recall-boosted, never evicted). Set via `POST /pin` and review resolution.
- **On-write consolidation**: `storeTrace` (`server/ingest.ts`) finds the nearest neighbor; if it is
  within `CONSOLIDATE_SIM_THRESHOLD` it enqueues a `memory_review` rather than merging silently —
  a human decides `merge` / `keep_separate` / `reject` via `POST /reviews/resolve`. `merge`
  reinforces the kept memory (and can auto-promote it at `REINFORCE_PROMOTE_AT`); `reject` retracts
  the candidate.
- **Reinforcement** (`reinforcement_count`): recall and merges strengthen a memory; count feeds the
  recall score (`RECALL_W_REINFORCE`) and tier promotion — the analog of memories strengthening on
  use and decaying when unused.
- **Recall weighting**: `PostgresAdapter.search` blends similarity × outcome × recency × reinforce ×
  pinned-boost, and filters out `superseded`/`retracted` memories.
- **"Dreaming" (offline consolidation)**: `runDream` (`server/consolidate/dream.ts`, via
  `npm run dream` / `POST /consolidate`) is the batch counterpart to on-write consolidation. Four
  idempotent passes over a domain's active memory: (1) **decay** — archive stale, unproven,
  unreinforced `working` memories (excluded from recall, kept for audit); (2) **promote** — recompute
  tiers, moving proven (`success`) or recurring memories `working`→`consolidated`; (3) **dedup** —
  batch near-duplicate detection into the review queue, each with a **model-proposed** resolution;
  (4) **abstract** — condense recurring decisions on one task into a signed, recall-indexed
  `Semantic` memory (episodic→semantic) that also feeds distillation. `dryRun` reports without
  mutating. The reasoning (proposals + gisting) uses the pluggable, provider-neutral memory model
  (`server/memory/model.ts`); `local` is deterministic/offline.

## Wake (session-start priming)

The recall counterpart to **ingest** (acquisition) and **dream** (consolidation) — the three
"circadian" operations of the memory architecture. A fresh session (or a context-window compaction
that summarizes away the working state) makes an agent lose its sense of self: who it is, how it
operates, what it was just doing. **Wake** reconstitutes that from *durable memory* instead of a
lossy summary. `composeWake` (`server/wake/wake.ts`) assembles three layers for a trust domain:

- **identity** — the agent's durable self: human-pinned memories, abstracted `Semantic` principles,
  and ingested agent-specs (`boundContext` carries `type:agent-spec`), ranked so the most
  identity-defining material comes first (`PostgresAdapter.identityMemories`). This is the part a
  compaction must never erase.
- **recent** — the most recent active decisions, newest first ("what was I just doing";
  `PostgresAdapter.recentMemories`), de-duplicated against the identity layer.
- **relevant** — when the session has a `task`, the top precedents for it (the same
  similarity × outcome × recency recall as `/search`), so the agent wakes already oriented.

It returns the structured layers plus a `digest` — a ready-to-inject natural-language brief. Wake is
a **read-only compose** (no writes, no signing, like `/search`), so it is cheap and safe to run on
every connect. Surfaces: `POST /wake` (read), the MCP `wake` tool and `memory://<domain>/wake`
resource, and — most importantly — the MCP `initialize` `instructions` (so a harness reloads the
agent's self on connect without an explicit tool call; toggle with `MCP_WAKE_INSTRUCTIONS`).

## Cursor Cloud specific instructions

- The environment is repo-managed via `.cursor/environment.json`: `install` runs `npm install`,
  and a `carma-server` terminal runs `npm run dev` on port `7100`.
- Integration + MCP tests need a pgvector Postgres. Start one (e.g. a `pgvector/pgvector:pg16`
  container), set `DATABASE_URL`, run `npm run migrate`, then `npm test`.
- Prefer terminal/log evidence for walkthroughs; the resolver has no GUI, but the `/`
  configuration UI can be shown in a browser.
