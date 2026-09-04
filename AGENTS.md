# AGENTS.md

Guidance for coding agents working on CARMA (JSON-AM reference implementation).

## Running the app

- Install deps: `npm install`
- Start the dev server: `npm run dev` (runs `tsx server/index.js`), listens on port `7100`.

Use `npm run dev`, not `npm start`. The canonical entrypoint `server/index.js` imports
its middleware/adapters with `.js` specifiers, but those files are TypeScript (`server/middleware/*.ts`).
Plain `node server/index.js` fails with `ERR_MODULE_NOT_FOUND`; `tsx` resolves the `.js`
specifiers to their `.ts` sources. `tsx` is a dev dependency.

## Testing

This is a headless HTTP service — verify with terminal requests (no GUI). With the server
running on `:7100`:

- `curl http://localhost:7100/health` -> `ok` (HTTP 200)
- `curl "http://localhost:7100/resolve?uri=memory://acme/sem/example"` -> `403 Forbidden: Missing token`
- `curl -H "Authorization: Bearer bad.token" "http://localhost:7100/resolve?uri=memory://acme/sem/example"` -> `403` (jose rejects)
- Disallowed scheme / path traversal in `uri` -> `403` (guardrails in `server/middleware/guardrails.ts`)

Known gap: a successful `200` from `/resolve` is not reachable through config alone, because
`server/index.js` passes the raw `PUBLIC_KEY` env string directly to `jose`'s `jwtVerify`, but
EdDSA requires a `KeyObject`/`CryptoKey`/JWK. Fixing the happy path requires an application
code change (parse `PUBLIC_KEY` into a key object).

## Cursor Cloud specific instructions

- The environment is repo-managed via `.cursor/environment.json`: `install` runs `npm install`,
  and a `carma-server` terminal runs `npm run dev` on port `7100`.
- Prefer terminal/log evidence for walkthroughs; this service has no GUI, so screen recordings
  are not applicable to the resolver itself.
