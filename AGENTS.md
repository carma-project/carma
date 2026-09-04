# AGENTS.md

Guidance for coding agents working on CARMA (JSON-AM reference implementation).

## Running the app

- Install deps: `npm install`
- Dev server: `npm run dev` (runs `tsx server/index.js`), listens on port `7100`.
- Production start: `npm start` (runs `node --import tsx server/index.js`).

The entrypoint `server/index.js` imports its middleware/adapters with `.js` specifiers, but
those files are TypeScript (`server/middleware/*.ts`, `adapters/*.ts`). Plain
`node server/index.js` fails with `ERR_MODULE_NOT_FOUND`; `tsx` resolves the `.js` specifiers
to their `.ts` sources. `tsx` is a runtime dependency (not dev-only) so it is present in
production images.

## Configuration

`server/index.js` (the production entrypoint) does JWT auth + Postgres-backed resolution:

- `PORT` — HTTP port (default `7100`).
- `PUBLIC_KEY` — Ed25519 **SPKI PEM**. Imported at startup via `jose.importSPKI(..., 'EdDSA')`
  and used to verify capability tokens. If unset/invalid, the process still boots and `/health`
  works, but `/resolve` returns `403`.
- `DATABASE_URL` — Postgres connection string. Apply `adapters/postgres-schema.sql` first.

## Testing

Headless HTTP service — verify with terminal requests (no GUI). With the server on `:7100`:

- `curl http://localhost:7100/health` -> `ok` (HTTP 200)
- No token -> `403 Forbidden: Missing token`
- Invalid JWT -> `403` (jose rejects)
- Disallowed scheme / path traversal in `uri` -> `403` (guardrails in `server/middleware/guardrails.ts`)
- Valid Ed25519 capability token (`jsonam.domains`/`actions` matching the URI) + a matching row
  in `agent_memory` -> `200` with the envelope; authorized-but-missing URI -> `404`.

The full stack (app + Postgres) runs locally via `docker compose up --build` after supplying
`PUBLIC_KEY` (e.g. `PUBLIC_KEY="$(cat pub.pem)" docker compose up --build`).

## Deployment

- Container: `Dockerfile` (`node:20-alpine`, `npm ci --omit=dev`, `CMD node --import tsx server/index.js`).
  A `.dockerignore` keeps `node_modules` and local secrets out of the image.
- Railway uses Nixpacks (`railway.toml` -> `nixpacks.toml`), start `node --import tsx server/index.js`,
  healthcheck `/health`. Provide `DATABASE_URL` and `PUBLIC_KEY` env vars and add a Postgres service.

## Cursor Cloud specific instructions

- The environment is repo-managed via `.cursor/environment.json`: `install` runs `npm install`,
  and a `carma-server` terminal runs `npm run dev` on port `7100`.
- Prefer terminal/log evidence for walkthroughs; this service has no GUI, so screen recordings
  are not applicable to the resolver itself.
