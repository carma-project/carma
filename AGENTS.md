# AGENTS.md

Guidance for coding agents working on CARMA (JSON-AM reference implementation).

## Running the app

- Install deps: `npm install`
- Dev server: `npm run dev` (runs `tsx server/index.js`), listens on port `7100`.
- Production start: `npm start` (runs `node --import tsx server/index.js`).
- MCP server (stdio): `npm run mcp` (runs `node --import tsx server/mcp/stdio.ts`).
- Migrations: `npm run migrate` (applies `adapters/migrations/*.sql`, needs pgvector).
- Mint a capability token: `npm run mint-token -- --domains trust://acme --actions read,write`.
- Tests: `npm test` (unit always; integration + MCP tests run only when `DATABASE_URL` is set).

The entrypoint `server/index.js` imports its middleware/adapters with `.js` specifiers, but
those files are TypeScript (`server/**/*.ts`, `adapters/*.ts`). Plain `node server/index.js`
fails with `ERR_MODULE_NOT_FOUND`; `tsx` resolves the `.js` specifiers to their `.ts` sources.
`tsx` is a runtime dependency (not dev-only) so it is present in production images.

## Configuration

- `PORT` — HTTP port (default `7100`).
- `PUBLIC_KEY` — Ed25519 **SPKI PEM**. Imported at startup via `jose.importSPKI(..., 'EdDSA')`
  to verify capability tokens. If unset/invalid, the process still boots and `/health` works,
  but authenticated endpoints return `403`.
- `PRIVATE_KEY` — Ed25519 **PKCS8 PEM**. Signs stored envelopes on ingest and mints tokens.
- `DATABASE_URL` — Postgres connection string (needs pgvector). Run `npm run migrate` first.
- `TRUST_DOMAIN` — default trust domain for ingest/search when not supplied per-request.
- `EMBEDDING_PROVIDER` — embedding provider (default `local`, deterministic, no network).
- `EMBED_DIM` — embedding dimension (default `256`; must match the `vector(N)` column).

## Endpoints

- `GET /` (and `/ui`) — built-in, self-contained configuration/readiness UI (no external assets).
- `GET /api/status` — JSON deploy diagnostics: `PUBLIC_KEY`/`PRIVATE_KEY`, DB connectivity,
  `agent_memory` schema, and RAG (pgvector) readiness. Booleans only — never returns secrets.
- `GET /health` — liveness.
- `GET /resolve?uri=...` — resolve an envelope by URI (read capability).
- `POST /memory` — ingest a reasoning trace as a signed `trace://` envelope + RAG index entry
  (write capability). Body: `{ task?, content, boundContext?, trustDomain?, uri? }`.
- `GET /search?q=...&k=5&domain=acme` — semantic search; returns JSON-AM pointers + scores
  (read capability).

## MCP

`server/mcp/` exposes CARMA to agents. Tools: `store_trace({ task, content, boundContext })`
and `search_memory({ query, k })`; plus resource reads. A stdio connection is treated as a
trusted local channel (operates under `TRUST_DOMAIN`, signs with `PRIVATE_KEY`). The HTTP API
stays capability-gated.

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

## Cursor Cloud specific instructions

- The environment is repo-managed via `.cursor/environment.json`: `install` runs `npm install`,
  and a `carma-server` terminal runs `npm run dev` on port `7100`.
- Integration + MCP tests need a pgvector Postgres. Start one (e.g. a `pgvector/pgvector:pg16`
  container), set `DATABASE_URL`, run `npm run migrate`, then `npm test`.
- Prefer terminal/log evidence for walkthroughs; the resolver has no GUI, but the `/`
  configuration UI can be shown in a browser.
