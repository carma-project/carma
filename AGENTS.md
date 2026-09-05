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
- `LOG_LEVEL` (`info`) — structured JSON logs; each request gets an `X-Request-Id`.
- `HSTS_ENABLED` (`false`) — send HSTS (enable when TLS terminates at/after the proxy).
- `STRICT_BOOT` (`false`) — fail fast at startup if `PUBLIC_KEY`/`PRIVATE_KEY`/`DATABASE_URL`
  are missing (recommended in production).
- `MCP_HTTP_ENABLED` (default `true`) / `MCP_HTTP_PATH` (default `/mcp`) — expose the MCP
  Streamable HTTP transport on the main server so remote agent harnesses can connect.

## Endpoints

- `GET /` (and `/ui`) — built-in, self-contained configuration/readiness UI (no external assets).
- `GET /api/status` — JSON deploy diagnostics: `PUBLIC_KEY`/`PRIVATE_KEY`, DB connectivity,
  `agent_memory` schema, RAG (pgvector), and audit-log readiness. Booleans only — never secrets.
- `GET /health` — liveness (always `200` while the process is up).
- `GET /ready` — readiness (`200` only when it can serve: key valid + DB connected + schema);
  `503` otherwise. Use this for orchestrator readiness probes.
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
- `POST /pin` — pin/unpin a memory (write). Body: `{ uri, pinned? }` (default `true`). Pinned
  memories are boosted in recall and exempt from decay/eviction (see Consolidation & tiers).
- `GET /reviews?domain=acme&status=pending` — list consolidation reviews (near-duplicate merge
  decisions) awaiting a human call (read).
- `POST /reviews/resolve` — resolve a review (write). Body: `{ reviewId, resolution }` where
  `resolution` is `merge` (reinforce the kept memory), `keep_separate` (both stay), or `reject`
  (retract the candidate).
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
`retract_memory({ uri, reason? })`, and `search_memory({ query, k })` (precedent recall);
plus resource reads (`memory://<domain>/*`). Envelope schema: JSON-AM v0.1.3-draft (`docs/JSON-AM.md`).

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
- Railway uses Nixpacks (`railway.toml` -> `nixpacks.toml`), start `node --import tsx server/index.js`,
  healthcheck `/health`. Provide `DATABASE_URL`, `PUBLIC_KEY`, `PRIVATE_KEY`; add a pgvector
  Postgres service and run `npm run migrate`.

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
- **"Dreaming" (planned)**: an offline batch counterpart to on-write consolidation — decay/evict
  stale `working` memories, cluster near-duplicates into the review queue, recompute salience from
  outcomes, and abstract recurring episodic decisions into semantic memories (feeds distillation).
  Tracked in `docs/ROADMAP.md`.

## Cursor Cloud specific instructions

- The environment is repo-managed via `.cursor/environment.json`: `install` runs `npm install`,
  and a `carma-server` terminal runs `npm run dev` on port `7100`.
- Integration + MCP tests need a pgvector Postgres. Start one (e.g. a `pgvector/pgvector:pg16`
  container), set `DATABASE_URL`, run `npm run migrate`, then `npm test`.
- Prefer terminal/log evidence for walkthroughs; the resolver has no GUI, but the `/`
  configuration UI can be shown in a browser.
